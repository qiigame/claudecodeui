import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import {
  collaborationService,
  executionAttributionService,
} from '@/modules/collaboration/index.js';
import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { ClaudeMcpProvider } from '@/modules/providers/list/claude/index.js';
import { dataverseRuntimeBridgeService } from '@/modules/runtime-bridge/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { hasVerifiedDingTalkActor } from '@/modules/websocket/services/websocket-auth.service.js';
import {
  filterProviderEnvironmentForReadOnly,
  parseIncomingJsonObject,
  readAuthenticatedWebSocketUserId,
} from '@/shared/utils.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  forceRestart?: boolean;
  bypassPermissions?: boolean;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  /** Stable authenticated owner, retained across reconnects/detachments. */
  ownerUserId: string | number | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  provider: string;
  executionRunId: string | null;
  /** Removes per-process credentials/configuration after the PTY exits. */
  cleanup?: () => Promise<void>;
};

/**
 * Tracks an asynchronous PTY launch until it is installed in
 * `ptySessionsMap`. A newer init for the same key, or a socket close, marks
 * this token stale so a late provider/configuration resolution cannot create
 * an orphan process or overwrite a replacement session.
 */
type PendingPtyLaunch = {
  ws: WebSocket;
  /** Owner is kept separately from `ws` so revocation can cancel launches
   * from another socket for the same authenticated person. */
  ownerUserId: string | number | null;
  sessionKey: string;
  sessionId: string | null;
  provider: string;
  /** Connection-local init generation that created this launch. */
  generation: number;
  cancelled: boolean;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const pendingPtyLaunches = new Map<string, PendingPtyLaunch>();
const moduleRequire = createRequire(import.meta.url);
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const PROVIDER_SHELL_HANDOFF_DELAY_MS = 100;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;

/**
 * Resolve the version-pinned CLI shipped with the SDK packages.  A managed
 * server often has no `codex`/`claude` executable on its login PATH (and a
 * different global version can be incompatible with the Web SDK), so an
 * interactive PTY must use the same bundled runtime whenever the operator
 * has not explicitly selected another executable.
 */
function resolveBundledCodexCliPath(): string | undefined {
  try {
    return moduleRequire.resolve('@openai/codex/bin/codex.js');
  } catch {
    return undefined;
  }
}

function resolveBundledClaudeCliPath(): string | undefined {
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    return moduleRequire.resolve(
      `${packageName}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`,
    );
  } catch {
    return undefined;
  }
}

function sameShellOwner(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): boolean {
  return left !== null
    && left !== undefined
    && right !== null
    && right !== undefined
    && String(left) === String(right);
}

function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

function normalizeDetectedUrl(url: string): string | null {
  const cleanedUrl = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, '');
  if (!cleanedUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(cleanedUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function extractUrlsFromText(value: string): string[] {
  const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) ?? [];

  // Terminal width can split a URL across lines, so valid URL characters on
  // immediately following lines are joined before the URL is validated.
  const wrappedMatches: string[] = [];
  const urlContinuationPattern = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
  const lines = value.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
    if (!startMatch) {
      continue;
    }

    let combinedUrl = startMatch[0];
    let continuationIndex = lineIndex + 1;
    while (continuationIndex < lines.length) {
      const continuation = lines[continuationIndex].trim();
      if (!continuation || !urlContinuationPattern.test(continuation)) {
        break;
      }
      combinedUrl += continuation;
      continuationIndex += 1;
    }

    wrappedMatches.push(combinedUrl);
  }

  return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

function shouldAutoOpenUrlFromOutput(value: string): boolean {
  const normalizedOutput = value.toLowerCase();
  return (
    normalizedOutput.includes("browser didn't open") ||
    normalizedOutput.includes('open this url') ||
    normalizedOutput.includes('continue in your browser') ||
    normalizedOutput.includes('press enter to open') ||
    normalizedOutput.includes('open_url:')
  );
}

type ShellWebSocketDependencies = {
  /**
   * Startup-resolved deployment policy. Interactive PTY access is deliberately
   * denied when this policy does not grant `terminal.interactive`; an omitted
   * policy keeps standalone/unit-test callers on the legacy developer path.
   */
  deploymentPolicy?: DeploymentPolicy;
  /**
   * Compatibility alias for older websocket composition roots. Shell is an
   * execution-only transport, so either managed-identity switch implies the
   * verified actor gate (there is no pending/read-only shell mode).
   */
  requireDingTalkActor?: boolean;
  /** Managed SSO sessions must carry a verified DingTalk project actor. */
  requireVerifiedDingTalkActor?: boolean;
  /**
   * Optional dynamic actor revalidator. A long-lived terminal socket must not
   * retain command execution after an administrator revokes its DingTalk
   * binding. When omitted, the shell consults the collaboration registry
   * itself immediately before init/input/resize operations.
   */
  isActorVerified?: (userId: string | number) => boolean;
  resolveProviderSessionId: (
    sessionId: string,
    provider: string,
  ) => string | null | undefined;
  resolveSessionProjectPath: (sessionId: string) => string | null;
  spawnPty?: typeof pty.spawn;
  resolveProviderRuntime?: (
    provider: 'codex' | 'claude',
  ) => Promise<ShellProviderRuntime | null>;
  /**
   * Reads host-owned Claude MCP definitions for a terminal launch. This is
   * injectable so shell tests never inspect the operator's real config.
   */
  resolveClaudeMcpServers?: () => Promise<Record<string, unknown> | null>;
  /** Creates an isolated Claude `--mcp-config` file for one PTY. */
  createClaudeMcpConfig?: (
    servers: Record<string, unknown>,
  ) => Promise<TemporaryClaudeMcpConfig>;
  /**
   * Optional deployment-owned executable allowlist for the exceptional case
   * where a managed read-only host ships a pinned provider binary outside the
   * SDK package. Values are supplied by the trusted composition root; request
   * payloads and provider runtime environments cannot add entries.
   */
  allowedReadOnlyProviderExecutables?: readonly string[];
  /**
   * Optional deployment-owned credential names for a custom model provider.
   * The default filter only forwards the standard provider credentials; a
   * custom name must be explicitly approved by the trusted composition root.
   */
  allowedReadOnlyProviderCredentialKeys?: readonly string[];
};

// Direct/legacy callers do not have the composition-root snapshot. Cache the
// fallback on first use so a later process.env mutation cannot reopen PTY
// execution in a long-lived server.
let shellWebSocketStartupPolicy: DeploymentPolicy | undefined;

function getShellWebSocketStartupPolicy(): DeploymentPolicy {
  shellWebSocketStartupPolicy ??= parseDeploymentPolicy();
  return shellWebSocketStartupPolicy;
}

/**
 * Resolves the process-owned policy for direct/legacy shell entry points that
 * predate explicit policy injection. The ordinary no-profile case remains the
 * writable self-hosted default, while a configured product/QA process cannot
 * reopen PTY execution through an alternate caller that omitted the policy.
 */
function withResolvedShellDeploymentPolicy(
  dependencies: ShellWebSocketDependencies,
): ShellWebSocketDependencies {
  return dependencies.deploymentPolicy
    ? dependencies
    : { ...dependencies, deploymentPolicy: getShellWebSocketStartupPolicy() };
}

type ShellProviderRuntime = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  /** Host-owned MCP definitions to expose to an interactive Claude PTY. */
  mcpServers?: Record<string, unknown>;
  /** Trusted model credential names used by custom provider snapshots. */
  allowedCredentialKeys?: readonly string[];
};

type ShellActorVerification = () => boolean;

const READ_ONLY_PROVIDER_BARE_EXECUTABLES: Readonly<Record<'codex' | 'claude', readonly string[]>> = {
  codex: ['codex', 'codex.exe'],
  claude: ['claude', 'claude.exe'],
};

const READ_ONLY_PROVIDER_SCRIPT_EXTENSIONS = new Set([
  '.bash',
  '.cjs',
  '.js',
  '.mjs',
  '.pl',
  '.py',
  '.rb',
  '.sh',
  '.ts',
  '.tsx',
]);

const READ_ONLY_PROVIDER_INTERPRETER_NAMES = new Set([
  'ash',
  'bash',
  'bun',
  'cmd',
  'cmd.exe',
  'deno',
  'fish',
  'node',
  'node.exe',
  'perl',
  'perl.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'python',
  'python.exe',
  'ruby',
  'ruby.exe',
  'sh',
  'zsh',
]);

const READ_ONLY_PROVIDER_CONTROL_ENVIRONMENT_KEYS = [
  'CLOUDCLI_READONLY_HOME',
  'CLOUDCLI_READONLY_CODEX_HOME',
  'CLOUDCLI_READONLY_CLAUDE_CONFIG_DIR',
  'CLOUDCLI_READONLY_PATH',
] as const;

const READ_ONLY_CODEX_CONFIG_KEY_PATTERN = /^(?:model_provider|model_reasoning_effort|service_tier|web_search|check_for_update_on_startup|sandbox_workspace_write\.network_access|features\.(?:unbounded_connection_retries|plugins|remote_plugin|fast_mode)|model_providers\.[A-Za-z0-9_-]+\.(?:name|base_url|env_key|wire_api|requires_openai_auth|request_max_retries|stream_max_retries|stream_idle_timeout_ms))$/;

/**
 * Returns true when a provider launch belongs to a policy that is read-only.
 * The absent-policy case is intentionally kept as the legacy developer path
 * for direct/unit-test callers that do not construct a deployment context.
 */
function isReadonlyProviderLaunch(dependencies: ShellWebSocketDependencies): boolean {
  return Boolean(
    dependencies.deploymentPolicy
      && isDeploymentReadOnly(dependencies.deploymentPolicy),
  );
}

function normalizedExecutableName(value: string): string {
  return path.basename(value).toLowerCase();
}

/**
 * Validates the executable selected by an injected provider runtime. A runtime
 * resolver is an internal extension point, but it is still an execution
 * boundary: in a read-only deployment it may not replace Codex/Claude with a
 * shell, interpreter, or arbitrary workspace script. Explicit custom binaries
 * must be supplied by the trusted deployment composition root.
 */
function assertReadonlyProviderExecutable(
  provider: 'codex' | 'claude',
  executable: unknown,
  dependencies: ShellWebSocketDependencies,
): string {
  if (typeof executable !== 'string') {
    throw new Error('Read-only provider executable is invalid.');
  }

  const normalized = executable.trim();
  if (!normalized || /[\u0000\r\n]/.test(normalized)) {
    throw new Error('Read-only provider executable is invalid.');
  }

  const bundled = provider === 'codex'
    ? resolveBundledCodexCliPath()
    : resolveBundledClaudeCliPath();
  const explicitlyAllowed = new Set([
    ...(dependencies.allowedReadOnlyProviderExecutables ?? []),
    ...(bundled ? [bundled] : []),
  ]);
  if (explicitlyAllowed.includes(normalized)) {
    return normalized;
  }

  const executableName = normalizedExecutableName(normalized);
  const hasPath = normalized.includes('/') || normalized.includes('\\');
  if (!hasPath
    && READ_ONLY_PROVIDER_BARE_EXECUTABLES[provider].includes(executableName)
    && !READ_ONLY_PROVIDER_INTERPRETER_NAMES.has(executableName)) {
    return normalized;
  }

  // A path ending in a script extension or an interpreter name is rejected
  // even if a caller accidentally places it in the deployment allowlist. The
  // only script exception is the exact, version-pinned SDK binary above.
  if (READ_ONLY_PROVIDER_SCRIPT_EXTENSIONS.has(path.extname(executable).toLowerCase())
    || READ_ONLY_PROVIDER_INTERPRETER_NAMES.has(executableName)) {
    throw new Error('Read-only provider executable must be a pinned provider binary.');
  }

  throw new Error('Read-only provider executable is not deployment-approved.');
}

function assertSafeReadonlyCodexConfigValue(value: string): void {
  const separator = value.indexOf('=');
  const key = separator >= 0 ? value.slice(0, separator).trim() : value.trim();
  const configValue = separator >= 0 ? value.slice(separator + 1).trim().toLowerCase() : '';
  if (!READ_ONLY_CODEX_CONFIG_KEY_PATTERN.test(key)) {
    throw new Error('Read-only Codex configuration is not allowed.');
  }

  // These values are the concrete policy controls that could turn a provider
  // launch back into a writer/networked process.  The server-generated
  // read-only overrides are allowed only with their safe value.
  if ((key === 'sandbox_workspace_write.network_access' && configValue !== 'false')
    || (key === 'web_search' && !['"disabled"', 'disabled'].includes(configValue))
    || (key === 'check_for_update_on_startup' && configValue !== 'false')
    || (key === 'features.plugins' && configValue !== 'false')
    || (key === 'features.remote_plugin' && configValue !== 'false')
    || (key === 'features.unbounded_connection_retries' && configValue !== 'false')) {
    throw new Error('Read-only Codex configuration enables a forbidden capability.');
  }
}

function copyProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Keeps read-only provider state-root controls sourced from the process
 * boundary only. Runtime bridges and temporary MCP records are application
 * data; allowing either layer to replace `CLOUDCLI_READONLY_HOME` would let a
 * resolver redirect the child back to an operator-owned profile.
 */
function restoreTrustedReadonlyProviderControls(
  environment: Record<string, string>,
  processEnvironment: Record<string, string>,
): Record<string, string> {
  const restored = { ...environment };
  for (const controlKey of READ_ONLY_PROVIDER_CONTROL_ENVIRONMENT_KEYS) {
    for (const existingKey of Object.keys(restored)) {
      if (existingKey.toLowerCase() === controlKey.toLowerCase()) {
        delete restored[existingKey];
      }
    }
    const trustedKey = Object.keys(processEnvironment).find(
      (key) => key.toLowerCase() === controlKey.toLowerCase(),
    );
    const trustedValue = trustedKey ? processEnvironment[trustedKey] : undefined;
    if (trustedValue !== undefined) {
      restored[controlKey] = trustedValue;
    }
  }
  return restored;
}

/**
 * Rejects command-line values that can reopen a provider's write, shell, MCP,
 * or arbitrary-config channel. The validator runs after server-generated
 * resume/MCP arguments are appended, so a custom resolver cannot hide a
 * dangerous flag behind an otherwise valid runtime object.
 */
function assertReadonlyProviderArguments(
  provider: 'codex' | 'claude',
  args: unknown,
  temporaryClaudeMcpConfigPath?: string,
): void {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('Read-only provider arguments are invalid.');
  }

  const values = args as string[];
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument || /[\u0000\r\n]/.test(argument)) {
      throw new Error('Read-only provider arguments are invalid.');
    }

    const lower = argument.toLowerCase();
    if (
      lower.includes('dangerously-skip-permissions')
      || lower.includes('dangerously-bypass')
      || lower.includes('bypass-permissions')
      || lower.includes('danger-full-access')
      || lower === '--full-auto'
      || lower === '--yolo'
      || lower === '--allow-all'
      || lower === '--skip-permissions'
    ) {
      throw new Error('Read-only provider arguments enable a forbidden capability.');
    }

    if (provider === 'claude') {
      if (lower === '--mcp-config' || lower.startsWith('--mcp-config=')) {
        const expected = temporaryClaudeMcpConfigPath
          ? `--mcp-config=${temporaryClaudeMcpConfigPath}`
          : null;
        if (!expected || argument !== expected) {
          throw new Error('Read-only Claude MCP configuration path is not allowed.');
        }
      } else if (lower === '--strict-mcp-config') {
        // This is server-generated together with the private MCP file.
        if (!temporaryClaudeMcpConfigPath) {
          throw new Error('Read-only Claude MCP configuration path is not allowed.');
        }
      } else if (lower === '--model' || lower === '--resume') {
        const next = values[index + 1];
        if (!next || /[\u0000\r\n]/.test(next) || next.startsWith('-')) {
          throw new Error('Read-only Claude argument value is invalid.');
        }
        index += 1;
      } else if (argument.startsWith('-')) {
        throw new Error('Read-only Claude argument is not allowed.');
      }
      continue;
    }

    if (provider === 'codex') {
      if (lower === '--config') {
        const config = values[index + 1];
        if (!config) {
          throw new Error('Read-only Codex configuration is incomplete.');
        }
        assertSafeReadonlyCodexConfigValue(config);
        index += 1;
      } else if (lower === '--model') {
        const next = values[index + 1];
        if (!next || /[\u0000\r\n]/.test(next) || next.startsWith('-')) {
          throw new Error('Read-only Codex model argument is invalid.');
        }
        index += 1;
      } else if (lower === '--sandbox') {
        const next = values[index + 1]?.toLowerCase();
        if (next !== 'read-only') {
          throw new Error('Read-only Codex sandbox is not allowed.');
        }
        index += 1;
      } else if (lower === '--search') {
        // Live search is not enabled by the read-only terminal policy; this
        // flag is rejected rather than relying on a later config override.
        throw new Error('Read-only Codex search flag is not allowed.');
      } else if (lower === 'resume') {
        const next = values[index + 1];
        if (!next || !SAFE_SESSION_ID_PATTERN.test(next)) {
          throw new Error('Read-only Codex resume argument is invalid.');
        }
        index += 1;
      } else if (argument.startsWith('-')) {
        throw new Error('Read-only Codex argument is not allowed.');
      }
    }
  }
}

function requiresManagedShellIdentity(dependencies: ShellWebSocketDependencies): boolean {
  return dependencies.requireDingTalkActor === true
    || dependencies.requireVerifiedDingTalkActor === true
    // The product/QA profile is a managed multi-user deployment even when an
    // alternate composition root forgot to copy the auth-mode flag.
    || dependencies.deploymentPolicy?.profile === 'product-qa-readonly';
}

/**
 * Build a fail-closed verifier for a terminal connection. The initial actor
 * snapshot is useful for rejecting an unauthenticated upgrade, but it is not
 * sufficient for an already-open PTY: registry changes must be observed on
 * every operation that can launch or write to the process.
 */
function createShellActorVerification(
  request: AuthenticatedWebSocketRequest | undefined,
  dependencies: ShellWebSocketDependencies,
): ShellActorVerification {
  if (!requiresManagedShellIdentity(dependencies)) {
    return () => true;
  }

  const userId = readAuthenticatedWebSocketUserId(request);
  return () => {
    if (userId === null) {
      return false;
    }
    try {
      if (dependencies.isActorVerified) {
        return dependencies.isActorVerified(userId);
      }
      collaborationService.assertActorCanWrite(userId, { requireRegistry: true });
      return true;
    } catch {
      // Identity failures are an execution boundary. A registry/database
      // outage must disable the PTY rather than preserve the prior grant.
      return false;
    }
  };
}

/**
 * Per-PTY Claude MCP materialization returned by the shell launcher. The
 * cleanup callback is idempotent and must be called when the PTY exits.
 */
export type TemporaryClaudeMcpConfig = {
  path: string;
  /** Secret-bearing values are inherited by the PTY, never written to disk. */
  environment?: Record<string, string>;
  cleanup: () => Promise<void>;
};

type CodexProviderRuntimeConfig = {
  model_provider?: string;
  service_tier?: string;
  features?: {
    unbounded_connection_retries?: boolean;
    /** Managed CloudCLI launches keep curated marketplace sync disabled. */
    plugins?: boolean;
    /** Managed CloudCLI launches keep remote curated plugin sync disabled. */
    remote_plugin?: boolean;
    fast_mode?: boolean;
  };
  model_providers?: Record<string, {
    name?: string;
    base_url?: string;
    env_key?: string;
    wire_api?: string;
    requires_openai_auth?: boolean;
    request_max_retries?: number;
    stream_max_retries?: number;
    stream_idle_timeout_ms?: number;
  }>;
  /**
   * Host-owned, credential-sanitized MCP definitions. Literal credentials
   * must have been moved to `env` before this reaches the shell launcher.
   */
  mcp_servers?: Record<string, Record<string, unknown>>;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;

const claudeMcpProvider = new ClaudeMcpProvider();

/**
 * Loads the operator-owned Claude MCP set for the terminal runtime. Project
 * `.mcp.json` files are intentionally excluded by the provider so a checked
 * out repository cannot silently add an executable command to a PTY.
 */
async function resolveDefaultClaudeMcpServers(): Promise<Record<string, unknown> | null> {
  try {
    return await claudeMcpProvider.loadWebRuntimeServers();
  } catch {
    // A missing or malformed optional MCP file must not prevent the terminal
    // itself from starting. The Web runtime follows the same fail-soft rule.
    return null;
  }
}

const CLAUDE_MCP_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;
const CLAUDE_MCP_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// RFC 7230 token characters; unlike environment names this intentionally
// permits the hyphens used by common MCP headers such as `mcp-token` and
// `x-api-key`.
const CLAUDE_MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const THINKINGDATA_PROXY_ENV_KEYS = new Set([
  'CLOUDCLI_THINKINGDATA_MCP_URL',
  'CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV',
  'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
]);
const THINKINGDATA_PROXY_SCRIPT_NAME = 'thinkingdata-mcp-compat-proxy.js';
const CLAUDE_MCP_SENSITIVE_ARG_PATTERN = /^-{1,2}[A-Za-z0-9_.-]*(?:token|api[-_]?key|secret|password|authorization|credential)[A-Za-z0-9_.-]*(?:=(.*))?$/i;
const CLAUDE_MCP_SENSITIVE_QUERY_PATTERN = /(?:token|api[-_]?key|secret|password|authorization|credential)/i;

function isEnvironmentPlaceholder(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
}

function isPrototypePollutionKey(value: string): boolean {
  return value === '__proto__' || value === 'constructor' || value === 'prototype';
}

function isThinkingDataProxyServer(server: Record<string, unknown>): boolean {
  return server.command === process.execPath
    && Array.isArray(server.args)
    && server.args.some((entry) => (
      typeof entry === 'string' && entry.endsWith(THINKINGDATA_PROXY_SCRIPT_NAME)
    ));
}

function isSafeThinkingDataProxyMetadata(
  key: string,
  value: string,
): boolean {
  if (key === 'CLOUDCLI_THINKINGDATA_MCP_URL') {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:'
        && parsed.hostname.toLowerCase() === 'admin-ss.gamehaus.com'
        && parsed.pathname.startsWith('/mcp/analysis/http/')
        && !parsed.username
        && !parsed.password;
    } catch {
      return false;
    }
  }
  if (key === 'CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV') {
    return CLAUDE_MCP_ENV_NAME_PATTERN.test(value);
  }
  // The proxy reads this as a filesystem location, never as a credential.
  // Reject controls/newlines so it cannot alter the generated JSON or logs.
  return key === 'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE'
    && value.length <= 4096
    && !/[\u0000\r\n]/.test(value);
}

function sanitizeClaudeMcpArgs(
  serverName: string,
  args: string[],
  environment: Record<string, string>,
  usedNames: Set<string>,
): string[] {
  const sanitizedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const match = argument.match(CLAUDE_MCP_SENSITIVE_ARG_PATTERN);
    if (!match) {
      sanitizedArgs.push(argument);
      continue;
    }

    const optionName = argument.split('=', 1)[0];
    // Flags such as --token-env and --token-file intentionally carry an
    // environment variable name/path rather than a credential value.
    if (/(?:[-_]env|[-_]file)$/i.test(optionName)) {
      sanitizedArgs.push(argument);
      if (argument === optionName && args[index + 1] !== undefined) {
        sanitizedArgs.push(args[index + 1]);
        index += 1;
      }
      continue;
    }

    const inlineValue = match[1];
    // Consume the following token even when it starts with `-`: a secret can
    // legally begin with a dash, and leaving it in the config would defeat
    // the credential-scrubbing boundary.
    const hasSeparateValue = inlineValue === undefined && args[index + 1] !== undefined;
    const value = inlineValue ?? (hasSeparateValue ? args[index + 1] : undefined);
    if (value === undefined || isEnvironmentPlaceholder(value)) {
      sanitizedArgs.push(argument);
      if (hasSeparateValue) {
        sanitizedArgs.push(args[index + 1]);
        index += 1;
      }
      continue;
    }

    const environmentName = makeClaudeMcpEnvironmentName(
      serverName,
      `ARG_${index}`,
      usedNames,
    );
    environment[environmentName] = value;
    const placeholder = `\${${environmentName}}`;
    if (inlineValue !== undefined) {
      sanitizedArgs.push(argument.slice(0, argument.indexOf('=')) + '=' + placeholder);
    } else {
      sanitizedArgs.push(argument, placeholder);
      index += 1;
    }
  }
  return sanitizedArgs;
}

function hasCredentialBearingClaudeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(
      parsed.username
      || parsed.password
      || parsed.hash
      || Array.from(parsed.searchParams.keys()).some((key) => (
        CLAUDE_MCP_SENSITIVE_QUERY_PATTERN.test(key)
      )),
    );
  } catch {
    return true;
  }
}

function makeClaudeMcpEnvironmentName(
  serverName: string,
  fieldName: string,
  usedNames: Set<string>,
): string {
  const base = `CLOUDCLI_SHELL_MCP_${serverName}_${fieldName}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180) || 'CLOUDCLI_SHELL_MCP_VALUE';
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}`.slice(0, 200);
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Converts Claude MCP values into an env-backed form before writing them to
 * the temporary file. This covers generic user MCPs in addition to the
 * ThinkingData proxy: a token in `headers`/`env` therefore cannot leak into
 * the file, argv, or the WebSocket transcript.
 */
function sanitizeClaudeMcpServers(
  servers: Record<string, unknown>,
): { servers: Record<string, unknown>; environment: Record<string, string> } {
  const sanitizedServers: Record<string, unknown> = {};
  const environment: Record<string, string> = {};
  const usedNames = new Set<string>();

  for (const [serverName, rawValue] of Object.entries(servers)) {
    if (!CLAUDE_MCP_NAME_PATTERN.test(serverName)
      || isPrototypePollutionKey(serverName)
      || !rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      continue;
    }

    const rawServer = rawValue as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    const isThinkingDataProxy = isThinkingDataProxyServer(rawServer);
    let invalidThinkingDataMetadata = false;
    for (const field of ['type', 'command', 'url'] as const) {
      if (typeof rawServer[field] === 'string' && rawServer[field].trim()) {
        sanitized[field] = rawServer[field];
      }
    }
    if (Array.isArray(rawServer.args)
      && rawServer.args.every((entry) => typeof entry === 'string')) {
      sanitized.args = sanitizeClaudeMcpArgs(
        serverName,
        rawServer.args,
        environment,
        usedNames,
      );
    }

    if (typeof rawServer.url === 'string' && hasCredentialBearingClaudeUrl(rawServer.url)) {
      throw new Error('Claude MCP URL contains a literal credential.');
    }

    for (const field of ['env', 'headers'] as const) {
      const rawRecord = rawServer[field];
      if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
        continue;
      }
      const sanitizedRecord: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawRecord as Record<string, unknown>)) {
        const keyPattern = field === 'headers'
          ? CLAUDE_MCP_HEADER_NAME_PATTERN
          : CLAUDE_MCP_ENV_NAME_PATTERN;
        if (!keyPattern.test(key) || typeof value !== 'string') {
          continue;
        }
        if (isEnvironmentPlaceholder(value)) {
          sanitizedRecord[key] = value;
          continue;
        }
        // The compatibility proxy receives an `env` object per MCP child.
        // Keep its three metadata names and values local to that child: using
        // one parent-level generated variable for two ThinkingData servers
        // would make `analysis` and `analysis-extend` share one URL. These
        // values are URL/path/name metadata, not bearer credentials, and are
        // validated above before being written to the 0600 temp file.
        if (field === 'env' && isThinkingDataProxy && THINKINGDATA_PROXY_ENV_KEYS.has(key)) {
          if (!isSafeThinkingDataProxyMetadata(key, value)) {
            invalidThinkingDataMetadata = true;
            break;
          }
          sanitizedRecord[key] = value;
          continue;
        }
        const environmentName = makeClaudeMcpEnvironmentName(serverName, key, usedNames);
        environment[environmentName] = value;
        sanitizedRecord[key] = `\${${environmentName}}`;
      }
      if (Object.keys(sanitizedRecord).length > 0) {
        sanitized[field] = sanitizedRecord;
      }
      if (invalidThinkingDataMetadata) {
        break;
      }
    }

    if (!invalidThinkingDataMetadata && (sanitized.command || sanitized.url)) {
      sanitizedServers[serverName] = sanitized;
    }
  }

  return { servers: sanitizedServers, environment };
}

/**
 * Creates a one-PTY Claude MCP configuration outside the repository. Only the
 * path is passed in argv; a private 0700 directory and 0600 file protect the
 * short-lived config. Exported for focused shell tests and alternate hosts;
 * callers must invoke the returned idempotent cleanup callback after exit.
 */
export async function createClaudeMcpConfig(
  servers: Record<string, unknown>,
): Promise<TemporaryClaudeMcpConfig> {
  const sanitized = sanitizeClaudeMcpServers(servers);
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-mcp-'));
  const configPath = path.join(directory, 'config.json');
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    // mkdtemp currently creates a 0700 directory, but enforce the invariant
    // explicitly so a platform/runtime change cannot expose the config.
    await fsp.chmod(directory, 0o700);
    await fsp.writeFile(
      configPath,
      `${JSON.stringify({ mcpServers: sanitized.servers })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    // `mode` is ignored when a path is unexpectedly pre-created; enforce it
    // before returning even though mkdtemp makes the collision impossible.
    await fsp.chmod(configPath, 0o600);
    return {
      path: configPath,
      environment: sanitized.environment,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function cleanupTemporaryConfig(
  temporaryConfig: TemporaryClaudeMcpConfig | null,
): Promise<void> {
  if (!temporaryConfig) {
    return;
  }
  await temporaryConfig.cleanup().catch(() => undefined);
}

/**
 * Schedules best-effort cleanup from synchronous PTY/WebSocket callbacks.
 * Injected test/host cleanup implementations must not become unhandled
 * rejections when a process is killed during reconnect or shutdown.
 */
function scheduleCleanup(cleanup: (() => Promise<void>) | undefined): void {
  if (!cleanup) {
    return;
  }
  void cleanup().catch(() => undefined);
}

/**
 * Detaches a retained PTY from its websocket and gives a reconnect a bounded
 * window to reclaim it. The map-entry identity is captured so a delayed timer
 * can never terminate a replacement PTY that reused the same session key.
 */
function schedulePtySessionTimeout(
  sessionKey: string,
  session: PtySessionEntry,
): void {
  session.ws = null;
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  session.timeoutId = setTimeout(() => {
    if (ptySessionsMap.get(sessionKey) !== session || session.ws !== null) {
      return;
    }

    // Delete before kill because some PTY implementations invoke onExit
    // synchronously from kill(). The identity guard above protects a newer
    // entry that may have been installed under the same key.
    ptySessionsMap.delete(sessionKey);
    session.timeoutId = null;
    session.pty.kill();
    completeExecutionRun(session.executionRunId, 'failed');
    scheduleCleanup(session.cleanup);
  }, PTY_SESSION_TIMEOUT);
}

/** Marks a retained PTY run terminal when kill/timeout happens before onExit. */
function completeExecutionRun(
  runId: string | null | undefined,
  status: 'succeeded' | 'failed',
): void {
  if (!runId) {
    return;
  }
  try {
    executionAttributionService.completeExecution(runId, status);
  } catch {
    // Attribution is secondary to releasing the PTY and MCP credentials. Do
    // not turn a database shutdown race into an uncaught callback exception.
    console.error('[ERROR] Unable to complete shell execution attribution');
  }
}

/**
 * Releases an interactive provider PTY before the same app session is resumed
 * through Chat. Codex and Claude serialize writes to one provider thread; a
 * retained Shell PTY would otherwise keep that writer lock after its browser
 * socket closed and make the next Chat turn fail with `active writer`.
 *
 * Plain shells intentionally remain reconnectable and are not touched here.
 * Pending provider launches are cancelled as well, so a slow runtime resolver
 * cannot create an orphan PTY after Chat has taken ownership of the session.
 */
export async function terminateProviderShellSession(
  sessionId: string,
  provider: 'codex' | 'claude',
): Promise<number> {
  let terminated = 0;

  for (const [pendingKey, pendingLaunch] of pendingPtyLaunches.entries()) {
    if (
      pendingLaunch.sessionId !== sessionId
      || pendingLaunch.provider !== provider
    ) {
      continue;
    }
    pendingLaunch.cancelled = true;
    pendingPtyLaunches.delete(pendingKey);
  }

  for (const [sessionKey, session] of ptySessionsMap.entries()) {
    if (
      session.sessionId !== sessionId
      || session.provider !== provider
    ) {
      continue;
    }

    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }
    // Delete before kill because node-pty may synchronously emit onExit.
    // The entry identity guard in onExit then prevents duplicate cleanup.
    ptySessionsMap.delete(sessionKey);
    try {
      session.pty.kill();
    } catch {
      // The process may have exited between the map lookup and kill().
    }
    completeExecutionRun(session.executionRunId, 'failed');
    scheduleCleanup(session.cleanup);
    terminated += 1;
  }

  if (terminated > 0) {
    // node-pty emits process termination asynchronously. Give the provider's
    // thread store a bounded moment to release its writer before Chat resumes.
    await new Promise((resolve) => setTimeout(resolve, PROVIDER_SHELL_HANDOFF_DELAY_MS));
  }
  return terminated;
}

function resolveResumeSessionId(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const provider = readString(message.provider, 'claude');

  if (!hasSession || !sessionId) {
    return '';
  }

  let resumeSessionId: string | null | undefined;
  try {
    resumeSessionId = dependencies.resolveProviderSessionId(sessionId, provider);
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
    resumeSessionId = undefined;
  }

  const resolvedSessionId = resumeSessionId === undefined ? sessionId : resumeSessionId;
  if (!resolvedSessionId || !SAFE_SESSION_ID_PATTERN.test(resolvedSessionId)) {
    return '';
  }

  return resolvedSessionId;
}

function formatCodexConfigValue(value: string | boolean | number): string {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

const CODEX_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODEX_MCP_CONFIG_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODEX_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODEX_HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CODEX_MCP_APPROVAL_MODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODEX_PROXY_ENVIRONMENT_KEYS = new Set([
  'CLOUDCLI_THINKINGDATA_MCP_URL',
  'CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV',
  'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
]);

function appendCodexConfigValue(
  args: string[],
  keyPath: string,
  value: unknown,
): void {
  if (typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) {
    args.push('--config', `${keyPath}=${formatCodexConfigValue(value)}`);
    return;
  }

  if (Array.isArray(value) && value.every((entry) => (
    typeof entry === 'string'
    || typeof entry === 'boolean'
    || (typeof entry === 'number' && Number.isFinite(entry))
  ))) {
    // JSON arrays are valid TOML array literals for the scalar values allowed
    // by Codex MCP settings. No object is accepted here, which prevents an
    // accidental JSON object (and any embedded secret) from reaching argv.
    args.push('--config', `${keyPath}=${JSON.stringify(value)}`);
  }
}

function appendCodexMcpServerConfig(
  args: string[],
  serverName: string,
  rawServer: Record<string, unknown>,
): void {
  if (!CODEX_MCP_SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error('Codex MCP server name is invalid.');
  }

  // These fields may contain bearer tokens or arbitrary process credentials.
  // Runtime Bridge converts them to env-backed references before this point;
  // seeing one here means a caller bypassed that boundary, so fail closed.
  for (const forbiddenKey of ['http_headers', 'headers', 'token', 'api_key']) {
    if (Object.prototype.hasOwnProperty.call(rawServer, forbiddenKey)) {
      throw new Error('Codex MCP configuration contains a literal credential.');
    }
  }

  const prefix = `mcp_servers.${serverName}`;
  const url = rawServer.url;
  if (url !== undefined) {
    if (typeof url !== 'string') {
      throw new Error('Codex MCP URL is invalid.');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Codex MCP URL is invalid.');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Codex MCP URL is invalid.');
    }
    appendCodexConfigValue(args, `${prefix}.url`, url);
  }

  const command = rawServer.command;
  if (command !== undefined) {
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('Codex MCP command is invalid.');
    }
    appendCodexConfigValue(args, `${prefix}.command`, command);
  }

  if (url === undefined && command === undefined) {
    throw new Error('Codex MCP server transport is missing.');
  }

  // The ThinkingData compatibility proxy is a stdio MCP server. Its `env`
  // object contains only non-secret launch metadata (the upstream URL, the
  // name of an inherited token variable, and optionally a token-file path).
  // Generic literal environment values are normalized by Runtime Bridge into
  // `mcpEnvironment` + `env_vars`; accepting them here would put secrets in
  // argv, so only this narrow host-owned allow-list is supported.
  const environment = rawServer.env;
  if (environment !== undefined) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
      throw new Error('Codex MCP environment is invalid.');
    }
    for (const [environmentName, environmentValue] of Object.entries(environment)) {
      if (
        !CODEX_PROXY_ENVIRONMENT_KEYS.has(environmentName)
        || typeof environmentValue !== 'string'
        || !environmentValue.trim()
      ) {
        throw new Error('Codex MCP environment contains an unsupported value.');
      }

      if (environmentName === 'CLOUDCLI_THINKINGDATA_MCP_URL') {
        let parsedEnvironmentUrl: URL;
        try {
          parsedEnvironmentUrl = new URL(environmentValue);
        } catch {
          throw new Error('Codex MCP proxy URL is invalid.');
        }
        if (parsedEnvironmentUrl.protocol !== 'http:' && parsedEnvironmentUrl.protocol !== 'https:') {
          throw new Error('Codex MCP proxy URL is invalid.');
        }
      }

      if (environmentName === 'CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV'
        && !CODEX_ENVIRONMENT_KEY_PATTERN.test(environmentValue)) {
        throw new Error('Codex MCP proxy token environment variable is invalid.');
      }

      // `--config` parses the value as TOML. JSON string encoding safely
      // quotes paths/URLs without shell interpolation or accidental escapes.
      appendCodexConfigValue(
        args,
        `${prefix}.env.${environmentName}`,
        environmentValue,
      );
    }
  }

  const stringArrayFields = ['args', 'env_vars', 'enabled_tools'] as const;
  for (const field of stringArrayFields) {
    const value = rawServer[field];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      throw new Error(`Codex MCP ${field} is invalid.`);
    }
    appendCodexConfigValue(args, `${prefix}.${field}`, value);
  }

  const cwd = rawServer.cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || !cwd.trim() || command === undefined) {
      throw new Error('Codex MCP cwd is invalid.');
    }
    appendCodexConfigValue(args, `${prefix}.cwd`, cwd);
  }

  const bearerTokenEnvVar = rawServer.bearer_token_env_var;
  if (bearerTokenEnvVar !== undefined) {
    if (typeof bearerTokenEnvVar !== 'string'
      || !CODEX_ENVIRONMENT_KEY_PATTERN.test(bearerTokenEnvVar)) {
      throw new Error('Codex MCP bearer token environment variable is invalid.');
    }
    appendCodexConfigValue(args, `${prefix}.bearer_token_env_var`, bearerTokenEnvVar);
  }

  const approvalMode = rawServer.default_tools_approval_mode;
  if (approvalMode !== undefined) {
    if (typeof approvalMode !== 'string'
      || !CODEX_MCP_APPROVAL_MODE_PATTERN.test(approvalMode)) {
      throw new Error('Codex MCP approval mode is invalid.');
    }
    appendCodexConfigValue(args, `${prefix}.default_tools_approval_mode`, approvalMode);
  }

  for (const field of ['startup_timeout_sec', 'tool_timeout_sec'] as const) {
    const value = rawServer[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Codex MCP ${field} is invalid.`);
    }
    appendCodexConfigValue(args, `${prefix}.${field}`, value);
  }

  const envHttpHeaders = rawServer.env_http_headers;
  if (envHttpHeaders !== undefined) {
    if (!envHttpHeaders || typeof envHttpHeaders !== 'object' || Array.isArray(envHttpHeaders)) {
      throw new Error('Codex MCP environment headers are invalid.');
    }
    for (const [headerName, environmentName] of Object.entries(envHttpHeaders)) {
      if (!CODEX_HTTP_HEADER_NAME_PATTERN.test(headerName)
        || typeof environmentName !== 'string'
        || !CODEX_ENVIRONMENT_KEY_PATTERN.test(environmentName)) {
        throw new Error('Codex MCP environment headers are invalid.');
      }
      if (url === undefined) {
        throw new Error('Codex MCP environment headers require an HTTP server.');
      }
      if (!CODEX_MCP_CONFIG_KEY_PATTERN.test(headerName)) {
        // Header names are generally valid TOML keys but a dotted path segment
        // must stay conservative; the sanitizer can still expose the server
        // through its other supported auth fields.
        throw new Error('Codex MCP environment header name is unsupported.');
      }
      appendCodexConfigValue(
        args,
        `${prefix}.env_http_headers.${headerName}`,
        environmentName,
      );
    }
  }
}

/**
 * Appends sanitized MCP definitions to a Codex CLI launch. This is consumed
 * by the terminal runtime when CODEX_HOME is isolated; credentials remain in
 * the child environment and never become command-line values.
 */
export function appendCodexMcpConfigOverrides(
  args: string[],
  // Runtime resolvers may deserialize the snapshot as `Record<string,
  // unknown>` (the same shape used by the Claude config reader). Validate
  // each entry at the boundary below instead of requiring callers to perform
  // an unsafe cast merely to share the snapshot with the terminal launcher.
  mcpServers: Record<string, unknown> | undefined,
): void {
  if (!mcpServers) {
    return;
  }

  for (const [serverName, rawServer] of Object.entries(mcpServers)) {
    if (!rawServer || typeof rawServer !== 'object' || Array.isArray(rawServer)) {
      throw new Error('Codex MCP server configuration is invalid.');
    }
    appendCodexMcpServerConfig(args, serverName, rawServer as Record<string, unknown>);
  }
}

/**
 * Materializes the provider snapshot into CLI overrides.
 *
 * A CC-Switch-backed runtime can be marked as using the global config for the
 * normal host process. A terminal may deliberately run with an isolated
 * CODEX_HOME, however, so relying on that file makes the CLI fail with
 * "provider name must not be empty". The snapshot is read for each launch,
 * preserving provider switching without exposing credentials.
 */
export function appendCodexProviderConfigOverrides(
  args: string[],
  config: CodexProviderRuntimeConfig,
  /**
   * Optional sanitized MCP snapshot kept outside the SDK's structured config.
   * Runtime Bridge uses that split to clear inherited servers before applying
   * its serialized Web override; the terminal has no SDK merge layer, so it
   * must append the same snapshot directly.
   */
  mcpServers?: Record<string, Record<string, unknown>>,
): void {
  const providerName = config.model_provider;
  const providerConfig = providerName
    ? config.model_providers?.[providerName]
    : undefined;

  if (
    !providerName
    || !providerConfig?.name
    || !providerConfig.base_url
    || !providerConfig.env_key
    || !providerConfig.wire_api
    || typeof providerConfig.requires_openai_auth !== 'boolean'
  ) {
    throw new Error('Codex provider configuration is incomplete.');
  }

  args.push('--config', 'model_provider=' + formatCodexConfigValue(providerName));

  if (config.service_tier) {
    args.push('--config', 'service_tier=' + formatCodexConfigValue(config.service_tier));
  }
  if (typeof config.features?.unbounded_connection_retries === 'boolean') {
    args.push(
      '--config',
      'features.unbounded_connection_retries='
        + formatCodexConfigValue(config.features.unbounded_connection_retries),
    );
  }
  // The Web runtime bridge sets these to false on every turn.  Repeat the
  // invariant in the interactive launch as well: a terminal gets a fresh
  // isolated CODEX_HOME and must not start Codex's background curated
  // marketplace synchronizer (which otherwise competes with model/MCP
  // traffic). Local skills and the explicit MCP declarations remain enabled.
  args.push(
    '--config',
    'features.plugins=false',
    '--config',
    'features.remote_plugin=false',
  );
  if (typeof config.features?.fast_mode === 'boolean') {
    args.push(
      '--config',
      'features.fast_mode=' + formatCodexConfigValue(config.features.fast_mode),
    );
  }

  const providerPrefix = 'model_providers.' + providerName;
  const requiredFields: Array<[string, string | boolean]> = [
    ['name', providerConfig.name],
    ['base_url', providerConfig.base_url],
    ['env_key', providerConfig.env_key],
    ['wire_api', providerConfig.wire_api],
    ['requires_openai_auth', providerConfig.requires_openai_auth],
  ];
  for (const [field, value] of requiredFields) {
    args.push(
      '--config',
      providerPrefix + '.' + field + '=' + formatCodexConfigValue(value),
    );
  }

  const numericFields: Array<[string, number | undefined]> = [
    ['request_max_retries', providerConfig.request_max_retries],
    ['stream_max_retries', providerConfig.stream_max_retries],
    ['stream_idle_timeout_ms', providerConfig.stream_idle_timeout_ms],
  ];
  for (const [field, value] of numericFields) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      args.push(
        '--config',
        providerPrefix + '.' + field + '=' + formatCodexConfigValue(value),
      );
    }
  }

  appendCodexMcpConfigOverrides(args, mcpServers ?? config.mcp_servers);
}

/**
 * Adds the ephemeral Codex CLI settings required by the web terminal.
 *
 * Provider metadata is materialized separately from the current CC-Switch
 * snapshot, while these ephemeral overrides only affect this invocation:
 * workspace-write commands may reach MCP/HTTP endpoints and the built-in live
 * web-search tool is available. Rebuilding both layers on every launch keeps
 * provider switches and resumed threads aligned with the latest settings.
 */
function appendCodexTerminalConfigOverrides(
  args: string[],
  deploymentReadOnly = false,
): void {
  args.push(
    ...(deploymentReadOnly ? [] : [
      // The interactive CLI exposes live search through this global flag. Keep
      // the config override as well for compatibility with Codex releases that
      // read it before constructing the TUI.
      '--search',
    ]),
    '--sandbox',
    deploymentReadOnly ? 'read-only' : 'workspace-write',
    '--config',
    deploymentReadOnly
      ? 'sandbox_workspace_write.network_access=false'
      : 'sandbox_workspace_write.network_access=true',
    '--config',
    deploymentReadOnly ? 'web_search="disabled"' : 'web_search="live"',
    // CloudCLI controls CLI upgrades as part of the server release. An update
    // prompt would otherwise consume the user's first keystroke (or even run
    // npm install) before the terminal is ready.
    '--config',
    'check_for_update_on_startup=false',
  );
}

/**
 * Converts the same in-memory Dataverse bridge used by Web chat into a
 * provider CLI launch. Credentials remain in the PTY child environment and
 * are never included in the command arguments or persisted configuration.
 */
async function resolveDataverseProviderRuntime(
  provider: 'codex' | 'claude',
  options: { deploymentReadOnly?: boolean } = {},
): Promise<ShellProviderRuntime | null> {
  const deploymentReadOnly = options.deploymentReadOnly === true;
  if (!dataverseRuntimeBridgeService.isConfigured({ deploymentReadOnly })) {
    return null;
  }

  if (provider === 'claude') {
    // The interactive terminal must use the same full-tool Claude mode as Web
    // Chat.  A host/CC-Switch settings file may carry CLAUDE_CODE_SIMPLE=1;
    // leaving it in the child environment silently disables MCP and several
    // built-in tools even though authentication succeeds.
    const runtime = await dataverseRuntimeBridgeService.resolveClaudeRuntime({
      omitSimpleMode: true,
      deploymentReadOnly,
    });
    if (!runtime) {
      return null;
    }

    // A readonly provider must use the release-pinned binary.  An executable
    // path from CC-Switch/host config is still useful for developer terminals,
    // but it is an arbitrary process boundary in a managed deployment.
    const executable = deploymentReadOnly
      ? resolveBundledClaudeCliPath() || 'claude'
      : runtime.env.CLAUDE_CLI_PATH?.trim()
        || resolveBundledClaudeCliPath()
        || 'claude';
    const mcpServers = await resolveDefaultClaudeMcpServers();
  return {
    executable,
      args: runtime.model ? ['--model', runtime.model] : [],
      env: runtime.env,
      ...(mcpServers ? { mcpServers } : {}),
    };
  }

  const runtime = await dataverseRuntimeBridgeService.resolveCodexRuntime({
    deploymentReadOnly,
  });
  if (!runtime) {
    return null;
  }

  const args: string[] = [];
  if (runtime.model) {
    args.push('--model', runtime.model);
  }
  if (runtime.reasoningEffort) {
    args.push(
      '--config',
      `model_reasoning_effort=${formatCodexConfigValue(runtime.reasoningEffort)}`,
    );
  }

  // Materialize the current provider even when CC-Switch marks the runtime as
  // global-config-backed. This PTY may use an isolated CODEX_HOME, so the
  // provider table must be present in the invocation itself.
    appendCodexProviderConfigOverrides(
      args,
      runtime.clientOptions.config,
      runtime.mcpServers,
    );

  // The SDK sets CODEX_API_KEY itself when it launches `codex exec`, but an
  // interactive PTY does not go through that wrapper.  Codex's TUI therefore
  // falls back to its login flow unless the same short-lived credential is
  // present under CODEX_API_KEY.  Keep it in the child environment only; it
  // must never be copied into argv, the generated config, or websocket frames.
  const codexEnvironment = { ...runtime.clientOptions.env };
  const configuredCredentialKey = runtime.clientOptions.config.model_providers
    ? Object.values(runtime.clientOptions.config.model_providers)[0]?.env_key
    : undefined;
  const credential = runtime.clientOptions.apiKey
    ?? (configuredCredentialKey ? codexEnvironment[configuredCredentialKey] : undefined)
    ?? codexEnvironment.OPENAI_API_KEY;
  if (credential && !codexEnvironment.CODEX_API_KEY) {
    codexEnvironment.CODEX_API_KEY = credential;
  }
  return {
    executable: deploymentReadOnly
      ? resolveBundledCodexCliPath() || 'codex'
      : runtime.clientOptions.codexPathOverride?.trim()
        || resolveBundledCodexCliPath()
        || 'codex',
    args,
    env: codexEnvironment,
    allowedCredentialKeys: runtime.clientOptions.config.model_providers
      ? Object.values(runtime.clientOptions.config.model_providers)
        .map((providerConfig) => providerConfig?.env_key)
        .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
      : [],
  };
}

function buildProviderRuntimeArgs(
  message: ShellIncomingMessage,
  provider: 'codex' | 'claude',
  runtime: ShellProviderRuntime,
  resumeSessionId: string,
  claudeMcpConfigPath?: string,
  deploymentReadOnly = false,
): string[] {
  const args = [...runtime.args];

  if (provider === 'codex') {
    // The built-in Dataverse resolver already materializes MCP definitions
    // while constructing `runtime.args`. Alternate/runtime-switch resolvers
    // may instead return the sanitized snapshot separately. In that case the
    // isolated interactive Codex process has no SDK merge layer, so append the
    // same definitions here. Avoid duplicating entries when a resolver has
    // already emitted them: duplicate `--config` keys make Codex apply an
    // order-dependent merge and can resurrect an inherited HTTP transport.
    const hasMaterializedMcp = args.some((arg) => (
      typeof arg === 'string' && arg.startsWith('mcp_servers.')
    ));
    if (!hasMaterializedMcp) {
      appendCodexMcpConfigOverrides(args, runtime.mcpServers);
    }
    appendCodexTerminalConfigOverrides(args, deploymentReadOnly);
    if (resumeSessionId) {
      args.push('resume', resumeSessionId);
    }
  }

  if (provider === 'claude') {
    if (claudeMcpConfigPath) {
      // Restrict the CLI to the host-owned, per-PTY file. Without this flag
      // Claude also discovers project/local MCP files from the checkout.
      // `--mcp-config` is variadic in Claude's CLI. Using the equals form
      // prevents it from consuming a later positional `--resume`/command
      // token when the CLI parser sees the interactive launch arguments.
      args.push(`--mcp-config=${claudeMcpConfigPath}`, '--strict-mcp-config');
    }
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }
    if (!deploymentReadOnly && readBoolean(message.bypassPermissions)) {
      args.push('--dangerously-skip-permissions');
    }
  }

  return args;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const resumeSessionId = resolveResumeSessionId(message, dependencies);
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (resumeSessionId) {
      return `cursor-agent --resume="${resumeSessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (resumeSessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${resumeSessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'opencode') {
    if (resumeSessionId) {
      return `opencode --session "${resumeSessionId}"`;
    }
    return initialCommand || 'opencode';
  }

  // Launching with the flag is what unlocks "bypass permissions" in the CLI's
  // shift+tab permission-mode cycle; it cannot be enabled from inside a
  // session started without it.
  const bypassFlag = readBoolean(message.bypassPermissions)
    ? ' --dangerously-skip-permissions'
    : '';
  const command = initialCommand || `claude${bypassFlag}`;
  if (resumeSessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${resumeSessionId}"${bypassFlag}; if ($LASTEXITCODE -ne 0) { claude${bypassFlag} }`;
    }
    return `claude --resume "${resumeSessionId}"${bypassFlag} || claude${bypassFlag}`;
  }
  return command;
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');
  const appData = readEnvValue(env, 'APPDATA');
  const candidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);

  const normalizedPathEntries = pathEntries.map((entry) => os.platform() === 'win32' ? entry.toLowerCase() : entry);
  const preferredEntries = candidates.filter((candidate, index) => {
    const normalizedCandidate = os.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    return (
      candidates.indexOf(candidate) === index &&
      normalizedPathEntries.includes(normalizedCandidate)
    );
  });

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const normalizedPreferredEntries = preferredEntries.map((entry) =>
    os.platform() === 'win32' ? entry.toLowerCase() : entry
  );

  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => {
      const normalizedEntry = os.platform() === 'win32' ? entry.toLowerCase() : entry;
      return !normalizedPreferredEntries.includes(normalizedEntry);
    }),
  ].join(delimiter);

  return { key: pathKey, value };
}

/**
 * Codex's SDK injects CODEX_API_KEY when it owns the child process, whereas
 * the interactive PTY receives the runtime environment verbatim. Mirror the
 * standard provider credential at the PTY boundary so an interactive launch
 * does not fall into Codex's login flow. The value remains child-only.
 */
function normalizeCodexChildEnvironment(
  provider: string,
  environment: Record<string, string>,
): Record<string, string> {
  if (provider !== 'codex' || environment.CODEX_API_KEY) {
    return environment;
  }

  const credential = environment.OPENAI_API_KEY;
  if (!credential) {
    return environment;
  }

  return { ...environment, CODEX_API_KEY: credential };
}

/**
 * Used by this module's websocket gateway to connect the standalone Shell UI
 * to a retained PTY while keeping process lifecycle ownership on the server.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies,
  request?: AuthenticatedWebSocketRequest,
): void {
  dependencies = withResolvedShellDeploymentPolicy(dependencies);
  // Capture the readonly deployment controls before any asynchronous runtime
  // resolver runs. These values are trusted startup configuration and cannot
  // be replaced by a provider snapshot or a websocket message.
  const deploymentReadOnly = isReadonlyProviderLaunch(dependencies);
  const readonlyStartupEnvironment = deploymentReadOnly
    ? copyProcessEnvironment()
    : null;
  // Evaluate the deployment gate first.  In a product/QA read-only process a
  // direct handler caller may intentionally omit an authenticated principal
  // while testing the safe rejection path; reporting the capability denial is
  // both more useful and avoids making identity status observable there.
  const terminalPolicyDenied = Boolean(
    dependencies.deploymentPolicy
      && (
        dependencies.deploymentPolicy.profile === 'product-qa-readonly'
        || !hasDeploymentCapability(
          dependencies.deploymentPolicy,
          DEPLOYMENT_CAPABILITIES.TERMINAL_INTERACTIVE,
        )
      ),
  );

  if (!terminalPolicyDenied
    && requiresManagedShellIdentity(dependencies)
    && !hasVerifiedDingTalkActor(request?.user)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'IDENTITY_ENROLLMENT_REQUIRED',
        message: 'A verified DingTalk project identity is required before starting a terminal.',
      }));
      const close = (ws as WebSocket & { close?: (code?: number, reason?: string) => void }).close;
      if (typeof close === 'function') {
        close.call(ws, 1008, 'Verified DingTalk identity required');
      }
    }
    return;
  }

  // A PTY is an arbitrary command-execution boundary: even a provider launch
  // that starts in a nominally read-only mode can be replaced with a plain
  // shell, fed `initialCommand`, or switched to a dangerous permission flag.
  // Product/QA deployments therefore fail closed before installing *any*
  // message listener or creating a process. The optional policy is retained
  // for lightweight callers that intentionally exercise the legacy developer
  // transport without a composition root.
  if (terminalPolicyDenied) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        message: 'Interactive terminal access is disabled for this deployment.',
      }));
      // Closing is best effort: the tiny fake sockets used by unit tests do
      // not implement close(), while real ws connections should not remain
      // open as an inert unauthorised transport.
      const close = (ws as WebSocket & { close?: (code?: number, reason?: string) => void }).close;
      if (typeof close === 'function') {
        close.call(ws, 1008, 'Interactive terminal access is disabled');
      }
    }
    return;
  }

  console.log('[INFO] Shell websocket connected');

  const userId = readAuthenticatedWebSocketUserId(request);
  // Keep this admission decision stable for the lifetime of the connection.
  // In the legacy/developer transport there is no asynchronous actor check;
  // avoiding an unnecessary `await` on that path preserves the synchronous
  // PTY handoff contract (and prevents a very short-lived shell from emitting
  // data before its listeners are installed). Managed product/QA sessions
  // still revalidate before and after every asynchronous launch step.
  const managedShellIdentity = requiresManagedShellIdentity(dependencies);
  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let socketClosed = false;
  let initGeneration = 0;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();

  const verifyActorForOperation = createShellActorVerification(request, dependencies);
  let identityRejected = false;
  const rejectIdentityForOperation = (): boolean => {
    let actorAllowed = true;
    if (managedShellIdentity) {
      // Injected host/test revalidators are outside this module's trust
      // boundary and may throw when the registry is unavailable. Treat an
      // indeterminate result exactly like a revoked actor; never let the
      // exception fall through to the generic output handler while leaving a
      // PTY alive.
      try {
        actorAllowed = verifyActorForOperation();
      } catch {
        actorAllowed = false;
      }
    }
    if (actorAllowed) {
      return false;
    }
    if (identityRejected) {
      return true;
    }
    identityRejected = true;
    socketClosed = true;
    initGeneration += 1;
    for (const [pendingKey, pendingLaunch] of pendingPtyLaunches.entries()) {
      if (pendingLaunch.ws === ws || sameShellOwner(pendingLaunch.ownerUserId, userId)) {
        pendingLaunch.cancelled = true;
        pendingPtyLaunches.delete(pendingKey);
      }
    }
    // Stop every PTY currently owned by this socket before closing the
    // transport.  Normally `close` follows immediately, but test/embedded
    // websocket implementations may not emit it synchronously; killing only
    // the connection's latest key would leave an earlier runtime-switch PTY
    // alive and writable after the actor was revoked.
    for (const [ownedSessionKey, ownedSession] of ptySessionsMap.entries()) {
      if (ownedSession.ws !== ws && !sameShellOwner(ownedSession.ownerUserId, userId)) {
        continue;
      }
      ptySessionsMap.delete(ownedSessionKey);
      if (ownedSession.timeoutId) {
        clearTimeout(ownedSession.timeoutId);
        ownedSession.timeoutId = null;
      }
      try {
        ownedSession.pty.kill();
      } catch {
        // The process may have exited between the lookup and kill.
      }
      completeExecutionRun(ownedSession.executionRunId, 'failed');
      scheduleCleanup(ownedSession.cleanup);
      if (ownedSession.pty === shellProcess) {
        shellProcess = null;
        ptySessionKey = null;
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'IDENTITY_ENROLLMENT_REQUIRED',
        message: 'A verified DingTalk project identity is required before using the terminal.',
      }));
      const close = (ws as WebSocket & { close?: (code?: number, reason?: string) => void }).close;
      if (typeof close === 'function') {
        close.call(ws, 1008, 'Verified DingTalk identity required');
      }
    }
    return true;
  };

  // Revalidate once after the upgrade as well. This closes the small window
  // where an administrator revokes an actor between verifyClient and the
  // route-specific connection callback.
  if (rejectIdentityForOperation()) {
    return;
  }

  ws.on('message', async (rawMessage) => {
    let callbackGeneration: number | null = null;
    try {
      if (socketClosed) {
        return;
      }
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      // `init` can launch/relaunch a process, while `input` and `resize` can
      // continue driving an already-running PTY. Revalidate all three frame
      // types instead of trusting the actor snapshot captured at upgrade.
      if (
        (data.type === 'init' || data.type === 'input' || data.type === 'resize')
        && rejectIdentityForOperation()
      ) {
        return;
      }

      if (data.type === 'init') {
        const generation = ++initGeneration;
        callbackGeneration = generation;
        // Invalidate every unfinished launch owned by this connection before
        // changing its active runtime/project. Otherwise a provider resolver
        // that finishes later could install an orphan PTY for the old view.
        for (const [pendingKey, pendingLaunch] of pendingPtyLaunches.entries()) {
          if (pendingLaunch.ws === ws) {
            pendingLaunch.cancelled = true;
            pendingPtyLaunches.delete(pendingKey);
          }
        }
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const requestedProjectPath = readString(data.projectPath, process.cwd());
        const authoritativeProjectPath = hasSession && sessionId
          ? dependencies.resolveSessionProjectPath(sessionId)
          : null;
        if (hasSession && sessionId && !authoritativeProjectPath) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session workspace was not found' }));
          return;
        }
        const projectPath = authoritativeProjectPath ?? requestedProjectPath;
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        // A read-only deployment has no safe arbitrary shell transport. The
        // normal product/QA composition rejects the socket before this frame;
        // keep the check here for alternate composition roots that expose a
        // terminal capability while still marking the policy read-only.
        if (deploymentReadOnly && (isPlainShell || (provider !== 'codex' && provider !== 'claude'))) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DEPLOYMENT_CAPABILITY_DENIED',
            message: 'Interactive terminal access is disabled for this deployment.',
          }));
          return;
        }

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        const runtimeKey = isPlainShell ? 'plain-shell' : provider;
        // Keep the key for this init immutable.  A websocket can receive a
        // second init (for example when the user presses “restart” while the
        // first launch is still resolving its runtime); callbacks belonging
        // to the first PTY must never observe the second key.
        const sessionKey = `${String(userId ?? 'legacy')}_${projectPath}_${sessionId ?? 'default'}_${runtimeKey}${commandSuffix}`;
        ptySessionKey = sessionKey;

        // A websocket may send a new init before the previous asynchronous
        // launch has finished resolving its provider/configuration. Retain
        // only the latest launch token for this key; the earlier callback
        // will observe the identity mismatch and clean up without spawning.
        const previousPendingLaunch = pendingPtyLaunches.get(sessionKey);
        if (previousPendingLaunch) {
          previousPendingLaunch.cancelled = true;
          pendingPtyLaunches.delete(sessionKey);
        }

        // If this connection switches project/runtime while its old PTY is
        // still retained, detach every old entry owned by this socket. This
        // prevents a later socket close from leaving those entries attached
        // forever while preserving them for a short reconnect window.
        for (const [ownedSessionKey, ownedSession] of ptySessionsMap.entries()) {
          if (ownedSessionKey !== sessionKey && ownedSession.ws === ws) {
            schedulePtySessionTimeout(ownedSessionKey, ownedSession);
          }
        }

        if (isLoginCommand || forceRestart) {
          const oldSession = ptySessionsMap.get(sessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
              oldSession.timeoutId = null;
            }
            // Remove the identity first.  node-pty implementations may emit
            // `onExit` synchronously from kill(); deleting before kill makes
            // that late callback a no-op and prevents duplicate attribution
            // completion or cleanup of the replacement entry.
            ptySessionsMap.delete(sessionKey);
            oldSession.pty.kill();
            completeExecutionRun(oldSession.executionRunId, 'failed');
            scheduleCleanup(oldSession.cleanup);
          }
        }

        const existingSession =
          isLoginCommand || forceRestart ? null : ptySessionsMap.get(sessionKey);
        if (existingSession) {
          if (socketClosed || generation !== initGeneration || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
            existingSession.timeoutId = null;
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            existingSession.buffer.forEach((bufferedData) => {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  data: bufferedData,
                })
              );
            });
          }

          existingSession.ws = ws;
          return;
        }

        const pendingLaunch: PendingPtyLaunch = {
          ws,
          ownerUserId: userId,
          sessionKey,
          sessionId,
          provider,
          generation,
          cancelled: false,
        };
        pendingPtyLaunches.set(sessionKey, pendingLaunch);
        const isLaunchActive = () => (
          !socketClosed
          && ws.readyState === WebSocket.OPEN
          && generation === initGeneration
          && pendingLaunch.ws === ws
          && pendingLaunch.generation === generation
          && pendingLaunch.sessionKey === sessionKey
          && !pendingLaunch.cancelled
          && pendingPtyLaunches.get(sessionKey) === pendingLaunch
        );
        const releasePendingLaunch = () => {
          if (pendingPtyLaunches.get(sessionKey) === pendingLaunch) {
            pendingPtyLaunches.delete(sessionKey);
          }
        };

        // Resources are created incrementally below. Keep one idempotent abort
        // path so a stale/closed init releases its temporary MCP file and any
        // attribution run exactly once, without emitting a misleading error.
        let temporaryClaudeMcpConfig: TemporaryClaudeMcpConfig | null = null;
        let execution: ReturnType<typeof executionAttributionService.beginExecution> | null = null;
        let launchAborted = false;
        let launchTransferred = false;
        const abortLaunch = async (): Promise<void> => {
          if (launchAborted || launchTransferred) {
            return;
          }
          launchAborted = true;
          releasePendingLaunch();
          const configToCleanup = temporaryClaudeMcpConfig;
          temporaryClaudeMcpConfig = null;
          await cleanupTemporaryConfig(configToCleanup);
          completeExecutionRun(execution?.runId, 'failed');
        };

        /**
         * Provider/MCP preparation can await network or filesystem work. A
         * DingTalk actor may be revoked during that wait, so the admission
         * check on the incoming `init` frame cannot be the only one. Reuse
         * the connection rejection path and abort all resources accumulated by
         * this launch before a PTY can be installed.
         */
        const ensureLaunchActor = async (): Promise<boolean> => {
          if (!requiresManagedShellIdentity(dependencies)) {
            return true;
          }
          let actorAllowed = false;
          try {
            actorAllowed = verifyActorForOperation();
          } catch {
            actorAllowed = false;
          }
          if (actorAllowed) {
            return true;
          }
          rejectIdentityForOperation();
          await abortLaunch();
          return false;
        };

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          // No asynchronous resource has been created before these local
          // validation checks, so keep the error frame synchronous (some
          // callers render it immediately after sending init).
          releasePendingLaunch();
          if (!socketClosed && generation === initGeneration && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          }
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          releasePendingLaunch();
          if (!socketClosed && generation === initGeneration && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          }
          return;
        }

        const resumeSessionId = resolveResumeSessionId(data, dependencies);
        let providerRuntime: ShellProviderRuntime | null = null;
        if (!isPlainShell && (provider === 'codex' || provider === 'claude')) {
          try {
            if (dependencies.resolveProviderRuntime) {
              providerRuntime = await dependencies.resolveProviderRuntime(provider);
            } else {
              providerRuntime = await resolveDataverseProviderRuntime(provider, {
                deploymentReadOnly: Boolean(
                  dependencies.deploymentPolicy
                  && isDeploymentReadOnly(dependencies.deploymentPolicy),
                ),
              });
            }
            if (!(await ensureLaunchActor())) {
              return;
            }
            if (!isLaunchActive()) {
              await abortLaunch();
              return;
            }
            if (deploymentReadOnly && !providerRuntime) {
              throw new Error('Read-only provider runtime is unavailable.');
            }
          } catch {
            const launchIsCurrent = isLaunchActive();
            await abortLaunch();
            if (!launchIsCurrent) {
              return;
            }
            console.error(`[ERROR] Unable to prepare ${provider} terminal runtime`);
            ws.send(JSON.stringify({
              type: 'error',
              message: `Unable to prepare ${provider} terminal runtime`,
            }));
            return;
          }
        }

        if (!isLaunchActive()) {
          await abortLaunch();
          return;
        }

        if (
          provider === 'claude'
          && providerRuntime
          && !providerRuntime.mcpServers
          // A custom runtime resolver is used by tests and alternate hosts;
          // do not unexpectedly read the operator's ~/.claude.json there.
          // The production resolver already includes host-owned MCP data.
          && (!dependencies.resolveProviderRuntime || dependencies.resolveClaudeMcpServers)
        ) {
          try {
            const resolveMcpServers =
              dependencies.resolveClaudeMcpServers ?? resolveDefaultClaudeMcpServers;
            const mcpServers = await resolveMcpServers();
            if (!(await ensureLaunchActor())) {
              return;
            }
            if (!isLaunchActive()) {
              await abortLaunch();
              return;
            }
            if (mcpServers) {
              providerRuntime = { ...providerRuntime, mcpServers };
            }
          } catch {
            if (!isLaunchActive()) {
              await abortLaunch();
              return;
            }
            console.error('[ERROR] Unable to read Claude MCP configuration');
          }
        }

        // Claude's isolated config directory intentionally contains no MCP
        // servers. Materialize the host-owned set into a private, per-PTY
        // file so the CLI receives `--mcp-config=<path>` without placing any
        // bearer token in argv. Plain shells and Codex keep their existing
        // launch path and never create this file.
        const shouldMaterializeClaudeMcp = provider === 'claude'
          && Boolean(providerRuntime)
          && !deploymentReadOnly
          && (
            // The built-in resolver owns the host-wide policy and must always
            // provide strict isolation, including an empty snapshot.
            !dependencies.resolveProviderRuntime
            // Injected/alternate resolvers opt into the same policy by
            // returning `mcpServers` (an empty object is meaningful here) or
            // by supplying an explicit MCP resolver.
            || providerRuntime?.mcpServers !== undefined
            || Boolean(dependencies.resolveClaudeMcpServers)
          );
        if (shouldMaterializeClaudeMcp && providerRuntime) {
          try {
            const createMcpConfig =
              dependencies.createClaudeMcpConfig ?? createClaudeMcpConfig;
            // Always materialize an explicit (possibly empty) file. This lets
            // `--strict-mcp-config` reliably prevent Claude from discovering
            // repository-controlled `.mcp.json` files when host MCP loading
            // returns no servers or a malformed optional config.
            temporaryClaudeMcpConfig = await createMcpConfig(providerRuntime.mcpServers ?? {});
            if (!(await ensureLaunchActor())) {
              return;
            }
            if (!isLaunchActive()) {
              await abortLaunch();
              return;
            }
          } catch {
            const launchIsCurrent = isLaunchActive();
            await abortLaunch();
            if (!launchIsCurrent) {
              return;
            }
            console.error('[ERROR] Unable to prepare Claude MCP configuration');
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Unable to prepare Claude MCP configuration',
            }));
            return;
          }
        }

        let shellCommand = '';
        let executable = '';
        let executableArgs: string[];
        try {
          shellCommand = providerRuntime ? '' : buildShellCommand(data, dependencies);
          executable = providerRuntime
            ? providerRuntime.executable
            : os.platform() === 'win32'
              ? 'powershell.exe'
              : 'bash';
          executableArgs = providerRuntime
            ? buildProviderRuntimeArgs(
              data,
              provider as 'codex' | 'claude',
              providerRuntime,
              resumeSessionId,
              temporaryClaudeMcpConfig?.path,
              deploymentReadOnly,
            )
            : os.platform() === 'win32'
              ? ['-Command', shellCommand]
              : ['-c', shellCommand];
        } catch (error) {
          const launchIsCurrent = isLaunchActive();
          await abortLaunch();
          if (!launchIsCurrent) {
            return;
          }
          throw error;
        }
        if (deploymentReadOnly) {
          assertReadonlyProviderExecutable(provider as 'codex' | 'claude', executable, dependencies);
          assertReadonlyProviderArguments(
            provider as 'codex' | 'claude',
            executableArgs,
            undefined,
          );
        }

        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);
        const processEnvironment = readonlyStartupEnvironment ?? copyProcessEnvironment();
        const mergedChildEnvironment = {
          ...processEnvironment,
          ...(providerRuntime?.env ?? {}),
          ...(temporaryClaudeMcpConfig?.environment ?? {}),
        };
        let childEnvironment = normalizeCodexChildEnvironment(provider, mergedChildEnvironment);
        try {
          execution = userId === null
            ? null
            : executionAttributionService.beginExecution({
              userId,
              sessionId,
              provider: isPlainShell ? 'plain-shell' : provider,
              projectPath: resolvedProjectPath,
            });
        } catch (error) {
          const launchIsCurrent = isLaunchActive();
          await abortLaunch();
          if (!launchIsCurrent) {
            return;
          }
          throw error;
        }

        if (deploymentReadOnly) {
          // Apply the filter only after attribution is merged. This prevents a
          // receipt token, Git identity, hook path, or future execution field
          // from being reintroduced by the final spawn object. State-root
          // controls are restored from the startup snapshot so runtime env
          // values cannot redirect the provider to an operator home.
          const readonlyEnvironment = restoreTrustedReadonlyProviderControls(
            {
              ...childEnvironment,
              ...(execution?.environment ?? {}),
            },
            processEnvironment,
          );
          const allowedCredentialKeys = [
            ...(dependencies.allowedReadOnlyProviderCredentialKeys ?? []),
            ...(providerRuntime?.allowedCredentialKeys ?? []),
          ];
          childEnvironment = filterProviderEnvironmentForReadOnly(
            readonlyEnvironment,
            {
              allowedCredentialKeys,
              requireIsolatedHome: true,
            },
          );
          childEnvironment = normalizeCodexChildEnvironment(provider, childEnvironment);
        }
        const prioritizedPath = prioritizeUserNpmGlobalBin(childEnvironment);

        if (managedShellIdentity) {
          if (!(await ensureLaunchActor()) || !isLaunchActive()) {
            await abortLaunch();
            return;
          }
        } else if (!isLaunchActive()) {
          await abortLaunch();
          return;
        }

        let spawnedProcess: IPty | null = null;
        try {
          spawnedProcess = (dependencies.spawnPty ?? pty.spawn)(executable, executableArgs, {
            name: 'xterm-256color',
            cols: termCols,
            rows: termRows,
            cwd: resolvedProjectPath,
            env: {
              ...childEnvironment,
              [prioritizedPath.key]: prioritizedPath.value,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              FORCE_COLOR: '3',
            },
          });
        } catch (error) {
          const launchIsCurrent = isLaunchActive();
          await abortLaunch();
          if (!launchIsCurrent) {
            return;
          }
          throw error;
        }

        // A close/re-init cannot normally interleave with this synchronous
        // spawn call, but retain the check for custom/test PTY factories that
        // synchronously emit lifecycle events or trigger websocket callbacks.
        if (!isLaunchActive()) {
          spawnedProcess?.kill();
          await abortLaunch();
          return;
        }
        if (managedShellIdentity && !(await ensureLaunchActor())) {
          spawnedProcess?.kill();
          await abortLaunch();
          return;
        }
        if (!isLaunchActive()) {
          spawnedProcess?.kill();
          await abortLaunch();
          return;
        }

        shellProcess = spawnedProcess;

        const processForLaunch = spawnedProcess;
        if (!processForLaunch) {
          await abortLaunch();
          throw new Error('PTY process was not created');
        }

        // Capture process, key, and entry identity before installing
        // callbacks.  These values are deliberately never read from the
        // mutable connection-level variables inside callbacks: a later
        // forceRestart may replace them while the old PTY is still emitting
        // data or an exit event.
        const spawnedSessionKey = sessionKey;
        const spawnedSession: PtySessionEntry = {
          pty: processForLaunch,
          ws,
          ownerUserId: userId,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          provider: isPlainShell ? 'plain-shell' : provider,
          executionRunId: execution?.runId ?? null,
          cleanup: temporaryClaudeMcpConfig?.cleanup,
        };
        ptySessionsMap.set(spawnedSessionKey, spawnedSession);
        launchTransferred = true;
        if (pendingPtyLaunches.get(spawnedSessionKey) === pendingLaunch) {
          pendingPtyLaunches.delete(spawnedSessionKey);
        }

        processForLaunch.onData((chunk) => {
          const session = ptySessionsMap.get(spawnedSessionKey);
          if (!session || session !== spawnedSession || session.pty !== processForLaunch) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
              .map((url) => normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        processForLaunch.onExit((exitCode) => {
          // An old PTY can emit onExit after forceRestart has installed a
          // replacement under the same key.  Only its own map entry may be
          // finalized; otherwise it could delete/clean up the replacement.
          const session = ptySessionsMap.get(spawnedSessionKey);
          if (!session || session !== spawnedSession || session.pty !== processForLaunch) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
            session.timeoutId = null;
          }

          completeExecutionRun(
            spawnedSession.executionRunId,
            exitCode.exitCode === 0 ? 'succeeded' : 'failed',
          );

          scheduleCleanup(session?.cleanup);

          ptySessionsMap.delete(spawnedSessionKey);
          // Do not clear a replacement process attached to this websocket
          // (or a process for another key) when an older PTY exits late.
          if (shellProcess === processForLaunch && ptySessionKey === spawnedSessionKey) {
            shellProcess = null;
            ptySessionKey = null;
          }
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'opencode'
                    ? 'OpenCode'
                  : 'Claude';
          welcomeMsg = hasSession && resumeSessionId
            ? `\x1b[36mResuming ${providerName} session ${resumeSessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        const activeSession = ptySessionKey ? ptySessionsMap.get(ptySessionKey) : null;
        // Capture the mutable connection-level process before narrowing. A
        // socket can receive a close/re-init callback while a custom PTY
        // implementation is dispatching this message; using the local value
        // keeps the identity check race-safe and satisfies strict narrowing.
        const currentShellProcess = shellProcess;
        if (currentShellProcess
          && activeSession
          && activeSession.pty === currentShellProcess
          && activeSession.ws === ws) {
          currentShellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        const activeSession = ptySessionKey ? ptySessionsMap.get(ptySessionKey) : null;
        const currentShellProcess = shellProcess;
        if (currentShellProcess
          && activeSession
          && activeSession.pty === currentShellProcess
          && activeSession.ws === ws) {
          currentShellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      const canReportError = !socketClosed
        && ws.readyState === WebSocket.OPEN
        && (callbackGeneration === null || callbackGeneration === initGeneration);
      if (canReportError) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    socketClosed = true;
    initGeneration += 1;
    // A provider/MCP resolver may still be awaiting I/O when the browser
    // disconnects. Mark those launches stale so their continuations clean up
    // instead of spawning a PTY that no socket can ever own.
    for (const [pendingKey, pendingLaunch] of pendingPtyLaunches.entries()) {
      if (pendingLaunch.ws === ws) {
        pendingLaunch.cancelled = true;
        pendingPtyLaunches.delete(pendingKey);
      }
    }

    // Mobile networks can deliver an old socket's close after its replacement
    // has attached. Only entries whose current owner is this socket may be
    // detached; iterate all keys because one socket can switch runtimes before
    // the browser emits close and the connection-level key then points only
    // at its latest PTY.
    for (const [sessionKey, session] of ptySessionsMap.entries()) {
      if (session.ws === ws) {
        if (session.provider === 'codex' || session.provider === 'claude') {
          // Provider CLIs own a serialized thread writer. Do not retain their
          // PTY after the Shell transport closes: Chat may resume immediately
          // and must not collide with a writer that no longer has a client.
          if (session.timeoutId) {
            clearTimeout(session.timeoutId);
            session.timeoutId = null;
          }
          ptySessionsMap.delete(sessionKey);
          try {
            session.pty.kill();
          } catch {
            // The provider may have exited between the close event and kill.
          }
          completeExecutionRun(session.executionRunId, 'failed');
          scheduleCleanup(session.cleanup);
        } else {
          // Plain shells are deliberately retained for the existing bounded
          // reconnect window.
          schedulePtySessionTimeout(sessionKey, session);
        }
      }
    }
    shellProcess = null;
    ptySessionKey = null;
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
