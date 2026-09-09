import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError } from '@/shared/utils.js';

/** Deployment profiles consumed by the server composition root and guards. */
export type DeploymentProfile =
  | 'product-qa-readonly'
  | 'developer'
  | 'development'
  | 'platform'
  | 'production'
  | 'self-hosted'
  | 'test';

/** Capability names are strings so an operator can add a future capability without a client release. */
export type DeploymentCapability = string;

/** Canonical capabilities used by route, websocket, and provider boundaries. */
export const DEPLOYMENT_CAPABILITIES = Object.freeze({
  REPO_READ: 'repo.read',
  REPO_WRITE: 'repo.write',
  PROJECT_READ: 'project.read',
  PROJECT_MUTATE: 'project.mutate',
  FILE_READ: 'file.read',
  FILE_WRITE: 'file.write',
  SESSION_READ: 'session.read',
  SESSION_WRITE: 'session.write',
  WORKTREE_READ: 'worktree.read',
  WORKTREE_MUTATE: 'worktree.mutate',
  GIT_READ: 'git.read',
  GIT_FETCH: 'git.fetch',
  GIT_WRITE: 'git.write',
  SHELL_EXECUTE: 'shell.exec',
  TERMINAL_READONLY: 'terminal.readonly',
  TERMINAL_INTERACTIVE: 'terminal.interactive',
  QA_RUN: 'qa.run',
  AGENT_USE: 'agent.use',
  PROVIDER_RUNTIME: 'provider.runtime',
  PROVIDER_WRITE: 'provider.write',
  MCP_READ: 'mcp.read',
  MCP_WRITE: 'mcp.write',
  PLUGIN_READ: 'plugin.read',
  /** Execute an installed plugin RPC/server without granting plugin management. */
  PLUGIN_USE: 'plugin.use',
  PLUGIN_WRITE: 'plugin.write',
  BROWSER_READ: 'browser.read',
  BROWSER_USE: 'browser.use',
  ATTACHMENT_UPLOAD: 'attachment.upload',
  CHAT_USE: 'chat.use',
  SETTINGS_READ: 'settings.read',
  SETTINGS_WRITE: 'settings.write',
  MEMORY_READ: 'memory.read',
  SKILL_READ: 'skill.read',
  MANAGED_AUTH: 'managed-auth',
  REMOTE_ACCESS: 'remote-access',
  LOCAL_FILESYSTEM: 'local-filesystem',
  LOCAL_GIT: 'local-git',
  LOCAL_SHELL: 'local-shell',
} as const);

/** Immutable capability map attached to a normalized deployment policy. */
export type DeploymentCapabilities = Readonly<Record<DeploymentCapability, boolean>>;

/** Parsed policy used by every server-side authorization boundary. */
export type DeploymentPolicy = {
  profile: DeploymentProfile;
  capabilities: DeploymentCapabilities;
};

/** Environment shape accepted by the deterministic policy parser. */
export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * A deployment policy supplied by a composition root or route factory.
 * Function sources are startup hooks, not per-request policy resolvers: route
 * factories must evaluate them once and retain the resulting snapshot.
 */
export type DeploymentPolicySource = DeploymentPolicy | (() => DeploymentPolicy);

/** Minimal authenticated actor metadata retained in request authorization context. */
export type DeploymentPolicyActor = {
  userId: string | number | null;
  actorId: string | number | null;
  provider: string | null;
};

/** Request hints attached by the policy middleware for auditing and path checks. */
export type DeploymentPolicyRequestContext = {
  actor: DeploymentPolicyActor | null;
  sessionId: string | null;
  projectPath: string | null;
  targetPath: string | null;
  canonicalTargetPath: string | null;
};

/** Options accepted by the Express deployment-policy guard factory. */
export type DeploymentPolicyMiddlewareOptions = {
  policy?: DeploymentPolicy | (() => DeploymentPolicy);
  capability?: DeploymentCapability;
  capabilities?: readonly DeploymentCapability[];
  profile?: DeploymentProfile | readonly DeploymentProfile[];
  profiles?: DeploymentProfile | readonly DeploymentProfile[];
  /** Optional existing path to canonicalize and constrain below `pathRoot`. */
  targetPath?: string | ((request: Request, context: DeploymentPolicyRequestContext) => string | null | undefined);
  pathRoot?: string | ((request: Request, context: DeploymentPolicyRequestContext) => string | null | undefined);
  statusCode?: number;
  errorCode?: string;
  message?: string;
};

/** Compatibility alias retained for modules that used the original guard name. */
export type DeploymentGuardOptions = DeploymentPolicyMiddlewareOptions;

type DeploymentPolicyRequest = Request & {
  user?: unknown;
  deploymentPolicy?: DeploymentPolicy;
  deploymentPolicyContext?: DeploymentPolicyRequestContext;
};

const PROFILE_NAMES = new Set<DeploymentProfile>([
  'product-qa-readonly',
  'developer',
  'development',
  'platform',
  'production',
  'self-hosted',
  'test',
]);

const PROFILE_ALIASES: Readonly<Record<string, DeploymentProfile>> = {
  dev: 'developer',
  local: 'developer',
  developer: 'developer',
  development: 'development',
  qa: 'product-qa-readonly',
  readonly: 'product-qa-readonly',
  'read-only': 'product-qa-readonly',
  'qa-readonly': 'product-qa-readonly',
  'product-qa': 'product-qa-readonly',
  'product-qa-readonly': 'product-qa-readonly',
  selfhosted: 'self-hosted',
  'self-hosted': 'self-hosted',
  oss: 'self-hosted',
  platform: 'platform',
  hosted: 'platform',
  cloud: 'platform',
  production: 'production',
  prod: 'production',
  test: 'test',
};

const READ_ONLY_CAPABILITIES = [
  DEPLOYMENT_CAPABILITIES.REPO_READ,
  DEPLOYMENT_CAPABILITIES.PROJECT_READ,
  DEPLOYMENT_CAPABILITIES.FILE_READ,
  DEPLOYMENT_CAPABILITIES.SESSION_READ,
  // Session rows, titles, archives, and personal conversation metadata are
  // safe application-data mutations. They do not grant filesystem, Git, or
  // provider-tool write access and are required for QA to create conversations.
  DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
  DEPLOYMENT_CAPABILITIES.WORKTREE_READ,
  DEPLOYMENT_CAPABILITIES.GIT_READ,
  DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
  DEPLOYMENT_CAPABILITIES.TERMINAL_READONLY,
  DEPLOYMENT_CAPABILITIES.QA_RUN,
  DEPLOYMENT_CAPABILITIES.MCP_READ,
  DEPLOYMENT_CAPABILITIES.PLUGIN_READ,
  DEPLOYMENT_CAPABILITIES.BROWSER_READ,
  DEPLOYMENT_CAPABILITIES.ATTACHMENT_UPLOAD,
  DEPLOYMENT_CAPABILITIES.CHAT_USE,
  DEPLOYMENT_CAPABILITIES.SETTINGS_READ,
  DEPLOYMENT_CAPABILITIES.MEMORY_READ,
  DEPLOYMENT_CAPABILITIES.SKILL_READ,
] as const;

const MUTATING_CAPABILITIES = [
  DEPLOYMENT_CAPABILITIES.REPO_WRITE,
  DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
  DEPLOYMENT_CAPABILITIES.FILE_WRITE,
  DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE,
  DEPLOYMENT_CAPABILITIES.GIT_FETCH,
  DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE,
  DEPLOYMENT_CAPABILITIES.TERMINAL_INTERACTIVE,
  DEPLOYMENT_CAPABILITIES.AGENT_USE,
  DEPLOYMENT_CAPABILITIES.PROVIDER_WRITE,
  DEPLOYMENT_CAPABILITIES.MCP_WRITE,
  DEPLOYMENT_CAPABILITIES.PLUGIN_USE,
  DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE,
  DEPLOYMENT_CAPABILITIES.BROWSER_USE,
  DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE,
  DEPLOYMENT_CAPABILITIES.LOCAL_FILESYSTEM,
  DEPLOYMENT_CAPABILITIES.LOCAL_GIT,
  DEPLOYMENT_CAPABILITIES.LOCAL_SHELL,
] as const;

const DEVELOPER_CAPABILITIES = [...READ_ONLY_CAPABILITIES, ...MUTATING_CAPABILITIES] as const;
const PLATFORM_CAPABILITIES = [
  ...READ_ONLY_CAPABILITIES,
  DEPLOYMENT_CAPABILITIES.MANAGED_AUTH,
  DEPLOYMENT_CAPABILITIES.REMOTE_ACCESS,
] as const;

const PROFILE_CAPABILITIES: Readonly<Record<DeploymentProfile, readonly string[]>> = {
  'product-qa-readonly': READ_ONLY_CAPABILITIES,
  developer: DEVELOPER_CAPABILITIES,
  development: DEVELOPER_CAPABILITIES,
  platform: PLATFORM_CAPABILITIES,
  production: PLATFORM_CAPABILITIES,
  'self-hosted': DEVELOPER_CAPABILITIES,
  test: DEVELOPER_CAPABILITIES,
};

/** Environment variable names accepted by the parser. */
export const DEPLOYMENT_POLICY_ENVIRONMENT_KEYS = Object.freeze({
  profile: 'CLOUDCLI_DEPLOYMENT_PROFILE',
  capabilities: 'CLOUDCLI_DEPLOYMENT_CAPABILITIES',
  legacyPlatform: 'VITE_IS_PLATFORM',
});

// Legacy names are accepted only at the trusted deployment-config boundary.
// They are never inferred from browser input.
const CAPABILITY_ALIASES: Readonly<Record<string, DeploymentCapability>> = {
  agent: DEPLOYMENT_CAPABILITIES.AGENT_USE,
  'agent-use': DEPLOYMENT_CAPABILITIES.AGENT_USE,
  'agent.use': DEPLOYMENT_CAPABILITIES.AGENT_USE,
  'attachment-upload': DEPLOYMENT_CAPABILITIES.ATTACHMENT_UPLOAD,
  'attachment.upload': DEPLOYMENT_CAPABILITIES.ATTACHMENT_UPLOAD,
  browser: DEPLOYMENT_CAPABILITIES.BROWSER_USE,
  'browser-control': DEPLOYMENT_CAPABILITIES.BROWSER_USE,
  'browser-use': DEPLOYMENT_CAPABILITIES.BROWSER_USE,
  'browser-read': DEPLOYMENT_CAPABILITIES.BROWSER_READ,
  'browser.read': DEPLOYMENT_CAPABILITIES.BROWSER_READ,
  'browser.use': DEPLOYMENT_CAPABILITIES.BROWSER_USE,
  chat: DEPLOYMENT_CAPABILITIES.CHAT_USE,
  'chat-use': DEPLOYMENT_CAPABILITIES.CHAT_USE,
  'chat.use': DEPLOYMENT_CAPABILITIES.CHAT_USE,
  'file-read': DEPLOYMENT_CAPABILITIES.FILE_READ,
  'file.read': DEPLOYMENT_CAPABILITIES.FILE_READ,
  'file-mutate': DEPLOYMENT_CAPABILITIES.FILE_WRITE,
  'file-write': DEPLOYMENT_CAPABILITIES.FILE_WRITE,
  'file.mutate': DEPLOYMENT_CAPABILITIES.FILE_WRITE,
  'file.write': DEPLOYMENT_CAPABILITIES.FILE_WRITE,
  'git-fetch': DEPLOYMENT_CAPABILITIES.GIT_FETCH,
  'git.fetch': DEPLOYMENT_CAPABILITIES.GIT_FETCH,
  'git-mutate': DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  'git.mutate': DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  'git-push': DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  'git.push': DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  git: DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  'git-read': DEPLOYMENT_CAPABILITIES.GIT_READ,
  'git.read': DEPLOYMENT_CAPABILITIES.GIT_READ,
  'git-write': DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  'git.write': DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  'local-filesystem': DEPLOYMENT_CAPABILITIES.LOCAL_FILESYSTEM,
  'local-git': DEPLOYMENT_CAPABILITIES.LOCAL_GIT,
  'local-shell': DEPLOYMENT_CAPABILITIES.LOCAL_SHELL,
  'memory-read': DEPLOYMENT_CAPABILITIES.MEMORY_READ,
  'memory.read': DEPLOYMENT_CAPABILITIES.MEMORY_READ,
  mcp: DEPLOYMENT_CAPABILITIES.MCP_WRITE,
  'mcp-read': DEPLOYMENT_CAPABILITIES.MCP_READ,
  'mcp.read': DEPLOYMENT_CAPABILITIES.MCP_READ,
  'mcp-write': DEPLOYMENT_CAPABILITIES.MCP_WRITE,
  'mcp.write': DEPLOYMENT_CAPABILITIES.MCP_WRITE,
  plugin: DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE,
  'plugin-read': DEPLOYMENT_CAPABILITIES.PLUGIN_READ,
  'plugin.read': DEPLOYMENT_CAPABILITIES.PLUGIN_READ,
  'plugin-use': DEPLOYMENT_CAPABILITIES.PLUGIN_USE,
  'plugin.use': DEPLOYMENT_CAPABILITIES.PLUGIN_USE,
  'plugin-write': DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE,
  'plugin.write': DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE,
  'plugin-manage': DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE,
  'project-read': DEPLOYMENT_CAPABILITIES.PROJECT_READ,
  'project.read': DEPLOYMENT_CAPABILITIES.PROJECT_READ,
  'project-mutate': DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
  'project-write': DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
  'project.mutate': DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
  'project.write': DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
  'provider-runtime': DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
  'provider.runtime': DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
  'provider-write': DEPLOYMENT_CAPABILITIES.PROVIDER_WRITE,
  'provider.write': DEPLOYMENT_CAPABILITIES.PROVIDER_WRITE,
  'qa-run': DEPLOYMENT_CAPABILITIES.QA_RUN,
  'qa.run': DEPLOYMENT_CAPABILITIES.QA_RUN,
  'repo-read': DEPLOYMENT_CAPABILITIES.REPO_READ,
  'repo.read': DEPLOYMENT_CAPABILITIES.REPO_READ,
  'repo-mutate': DEPLOYMENT_CAPABILITIES.REPO_WRITE,
  'repo-write': DEPLOYMENT_CAPABILITIES.REPO_WRITE,
  'repo.mutate': DEPLOYMENT_CAPABILITIES.REPO_WRITE,
  'repo.write': DEPLOYMENT_CAPABILITIES.REPO_WRITE,
  'session-read': DEPLOYMENT_CAPABILITIES.SESSION_READ,
  'session.read': DEPLOYMENT_CAPABILITIES.SESSION_READ,
  'session-mutate': DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
  'session-write': DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
  'session.mutate': DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
  'session.write': DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
  'settings-read': DEPLOYMENT_CAPABILITIES.SETTINGS_READ,
  'settings.read': DEPLOYMENT_CAPABILITIES.SETTINGS_READ,
  'settings-write': DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE,
  'settings.write': DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE,
  'skill-read': DEPLOYMENT_CAPABILITIES.SKILL_READ,
  'skill.read': DEPLOYMENT_CAPABILITIES.SKILL_READ,
  shell: DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE,
  'shell-exec': DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE,
  'shell-execute': DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE,
  'shell.exec': DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE,
  'terminal-interactive': DEPLOYMENT_CAPABILITIES.TERMINAL_INTERACTIVE,
  'terminal.interactive': DEPLOYMENT_CAPABILITIES.TERMINAL_INTERACTIVE,
  'terminal-readonly': DEPLOYMENT_CAPABILITIES.TERMINAL_READONLY,
  'terminal.readonly': DEPLOYMENT_CAPABILITIES.TERMINAL_READONLY,
  'worktree-read': DEPLOYMENT_CAPABILITIES.WORKTREE_READ,
  'worktree.read': DEPLOYMENT_CAPABILITIES.WORKTREE_READ,
  'worktree-mutate': DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE,
  'worktree-write': DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE,
  'worktree.mutate': DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE,
  'worktree.write': DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE,
};

function normalizeName(value: unknown): string {
  // Environment variable names use underscores while the public capability
  // contract uses dots/hyphens. Normalize both spellings at the trust
  // boundary so `CLOUDCLI_CAPABILITY_FILE_WRITE`, `file_write`, and
  // `file-write` all resolve through the same alias table. Unknown custom
  // names receive the same deterministic normalization rather than silently
  // becoming a second capability namespace.
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/_/g, '-')
    : '';
}

function canonicalCapability(value: unknown): string {
  const normalized = normalizeName(value);
  return CAPABILITY_ALIASES[normalized] ?? normalized;
}

function parseProfile(value: unknown): DeploymentProfile | null {
  const normalized = normalizeName(value).replace(/_/g, '-');
  return PROFILE_ALIASES[normalized]
    ?? (PROFILE_NAMES.has(normalized as DeploymentProfile) ? normalized as DeploymentProfile : null);
}

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = normalizeName(value);
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function addCapability(capabilities: Map<string, boolean>, name: unknown, enabled = true): void {
  const canonical = canonicalCapability(name);
  if (canonical) capabilities.set(canonical, enabled);
}

function parseCapabilityList(value: string | undefined, capabilities: Map<string, boolean>): void {
  if (!value?.trim()) return;
  try {
    const decoded: unknown = JSON.parse(value);
    if (Array.isArray(decoded)) {
      decoded.forEach((name) => addCapability(capabilities, name));
      return;
    }
    if (decoded && typeof decoded === 'object') {
      Object.entries(decoded).forEach(([name, enabled]) => {
        if (typeof enabled === 'boolean') addCapability(capabilities, name, enabled);
      });
      return;
    }
  } catch {
    // Fall through to the .env-friendly comma-separated form.
  }
  for (const entry of value.split(',')) {
    const [name, explicitValue] = entry.split('=', 2);
    const enabled = explicitValue === undefined ? true : parseBoolean(explicitValue);
    if (enabled !== null) addCapability(capabilities, name, enabled);
  }
}

function parseConfiguredProfile(environment: DeploymentEnvironment): DeploymentProfile {
  const raw = [
    environment.CLOUDCLI_DEPLOYMENT_PROFILE,
    environment.DEPLOYMENT_PROFILE,
    environment.CLOUDCLI_PROFILE,
    environment.VITE_DEPLOYMENT_PROFILE,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  if (raw !== undefined) {
    const profile = parseProfile(raw);
    if (profile) return profile;
    throw new AppError(`Unknown deployment profile "${raw.trim()}".`, {
      code: 'INVALID_DEPLOYMENT_PROFILE',
      statusCode: 400,
    });
  }
  // Declaring DingTalk SSO means this process is an externally reachable,
  // multi-user installation. A missing deployment profile must not silently
  // reopen Shell, Git and filesystem mutation in that situation. Operators
  // that intentionally need a writable DingTalk-backed development instance
  // can still opt in explicitly with the `developer` profile.
  const managedSsoDeclared = Boolean(
    environment.CLOUDCLI_DINGTALK_CREDENTIALS_FILE?.trim()
      || environment.CLOUDCLI_DINGTALK_PUBLIC_ORIGIN?.trim()
      || parseBoolean(environment.CLOUDCLI_REQUIRE_DINGTALK_AUTH) === true,
  );
  if (managedSsoDeclared) return 'product-qa-readonly';
  return parseBoolean(environment.VITE_IS_PLATFORM) === true ? 'platform' : 'self-hosted';
}

/** Resolves trusted deployment configuration. Read-only profiles cannot be reopened by env typos. */
export function parseDeploymentPolicy(environment: DeploymentEnvironment = process.env): DeploymentPolicy {
  const profile = parseConfiguredProfile(environment);
  const capabilities = new Map<string, boolean>();
  PROFILE_CAPABILITIES[profile].forEach((name) => addCapability(capabilities, name));
  parseCapabilityList(
    environment.CLOUDCLI_DEPLOYMENT_CAPABILITIES ?? environment.CLOUDCLI_CAPABILITIES,
    capabilities,
  );
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith('CLOUDCLI_CAPABILITY_')) continue;
    const enabled = parseBoolean(value);
    if (enabled !== null) addCapability(capabilities, name.slice('CLOUDCLI_CAPABILITY_'.length), enabled);
  }
  if (profile === 'product-qa-readonly') {
    for (const capability of MUTATING_CAPABILITIES) capabilities.set(capability, false);
  }
  return { profile, capabilities: Object.freeze(Object.fromEntries(capabilities)) };
}

/**
 * Captures the trusted deployment policy for a route/module at construction
 * time.  This is deliberately separate from request-context resolution:
 * composition middleware may attach a trusted `request.deploymentPolicy`
 * later, but a standalone mount must never re-read mutable `process.env` for
 * every request.  A supplied function is evaluated exactly once by the
 * caller's factory.
 */
export function captureDeploymentPolicy(source?: DeploymentPolicySource): DeploymentPolicy {
  return typeof source === 'function' ? source() : source ?? parseDeploymentPolicy();
}

/** Returns whether a policy grants the requested canonical or legacy capability. */
export function hasDeploymentCapability(policy: DeploymentPolicy, capability: DeploymentCapability): boolean {
  const canonical = canonicalCapability(capability);
  return canonical.length > 0 && policy.capabilities[canonical] === true;
}

/**
 * Returns whether an installed plugin may execute. `plugin.use` is the
 * least-privilege grant; `plugin.write` remains an explicit compatibility
 * grant for older developer deployments that predate the split capability.
 * Callers must use this predicate for startup, HTTP RPC, and WebSocket paths
 * so those transports cannot drift into different authorization semantics.
 */
export function hasPluginExecutionCapability(policy: DeploymentPolicy): boolean {
  return hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PLUGIN_USE)
    || hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE);
}

/** Throws the stable authorization error used by service-level checks. */
export function assertDeploymentCapability(policy: DeploymentPolicy, capability: DeploymentCapability): void {
  if (!hasDeploymentCapability(policy, capability)) {
    throw new AppError('This operation is not enabled for the deployment.', {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
      statusCode: 403,
      details: { profile: policy.profile, capability: canonicalCapability(capability) },
    });
  }
}

/** Returns true when a deployment is explicitly product/QA read-only or has no mutating capability. */
export function isDeploymentReadOnly(policy: DeploymentPolicy): boolean {
  return policy.profile === 'product-qa-readonly'
    || !MUTATING_CAPABILITIES.some((name) => hasDeploymentCapability(policy, name));
}

/** Tests a policy against one or more allowed profiles. */
export function isDeploymentProfile(
  policy: DeploymentPolicy,
  profiles: DeploymentProfile | readonly DeploymentProfile[],
): boolean {
  const allowed = Array.isArray(profiles) ? profiles : [profiles];
  return allowed.includes(policy.profile);
}

function readRecordValue(source: unknown, fields: readonly string[]): unknown {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  for (const field of fields) {
    if (record[field] !== undefined && record[field] !== null && record[field] !== '') return record[field];
  }
  return undefined;
}

function readStringValue(source: unknown, fields: readonly string[]): string | null {
  const value = readRecordValue(source, fields);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readIdValue(source: unknown, fields: readonly string[]): string | number | null {
  const value = readRecordValue(source, fields);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRequestTargetPath(request: Request): string | null {
  return readStringValue(request.params, ['targetPath', 'projectPath', 'path', 'filePath'])
    ?? readStringValue(request.body, ['targetPath', 'projectPath', 'path', 'filePath'])
    ?? readStringValue(request.query, ['targetPath', 'projectPath', 'path', 'filePath']);
}

/** Extracts actor and request target hints without trusting client identity fields. */
export function readDeploymentPolicyRequestContext(request: Request): DeploymentPolicyRequestContext {
  const user = (request as DeploymentPolicyRequest).user;
  const actor = user && typeof user === 'object' && 'actor' in user
    ? (user as Record<string, unknown>).actor
    : user;
  return {
    actor: actor && typeof actor === 'object'
      ? {
        userId: readIdValue(actor, ['userId', 'id']),
        actorId: readIdValue(actor, ['actorId', 'id']),
        provider: readStringValue(actor, ['provider', 'providerName']),
      }
      : null,
    sessionId: readStringValue(request.params, ['sessionId', 'session'])
      ?? readStringValue(request.body, ['sessionId', 'session'])
      ?? readStringValue(request.query, ['sessionId', 'session']),
    projectPath: readStringValue(request.params, ['projectPath'])
      ?? readStringValue(request.body, ['projectPath'])
      ?? readStringValue(request.query, ['projectPath']),
    targetPath: readRequestTargetPath(request),
    canonicalTargetPath: null,
  };
}

function optionPath(
  option: DeploymentPolicyMiddlewareOptions['targetPath'] | DeploymentPolicyMiddlewareOptions['pathRoot'],
  request: Request,
  context: DeploymentPolicyRequestContext,
): string | null {
  if (typeof option === 'function') {
    const value = option(request, context);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
  return typeof option === 'string' && option.trim() ? option.trim() : null;
}

async function canonicalizeTargetPath(
  request: Request,
  context: DeploymentPolicyRequestContext,
  options: DeploymentPolicyMiddlewareOptions,
): Promise<void> {
  const target = optionPath(options.targetPath, request, context);
  if (!target) return;
  const root = optionPath(options.pathRoot, request, context) ?? context.projectPath;
  const candidate = root && !path.isAbsolute(target) ? path.resolve(root, target) : target;
  context.canonicalTargetPath = root
    ? await resolveCanonicalPath(candidate, { beneath: root })
    : await resolveCanonicalPath(candidate);
}

function resolvePolicy(
  capturedPolicy: DeploymentPolicy | undefined,
  request?: Request,
): DeploymentPolicy {
  if (capturedPolicy) return capturedPolicy;
  const requestPolicy = (request as DeploymentPolicyRequest | undefined)?.deploymentPolicy;
  return requestPolicy ?? parseDeploymentPolicy();
}

/**
 * Attaches a startup-resolved deployment policy to each API request. This
 * middleware does not authenticate the caller and therefore must be mounted
 * only alongside the existing authenticated route boundaries; it merely
 * supplies a tamper-resistant policy context to downstream guards.
 */
export function createDeploymentPolicyContextMiddleware(
  policy: DeploymentPolicy,
): RequestHandler {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const requestWithPolicy = request as DeploymentPolicyRequest;
    requestWithPolicy.deploymentPolicy = policy;
    requestWithPolicy.deploymentPolicyContext = readDeploymentPolicyRequestContext(request);
    next();
  };
}

function deniedError(options: DeploymentPolicyMiddlewareOptions, policy: DeploymentPolicy): AppError {
  return new AppError(options.message ?? 'This operation is not enabled for the deployment.', {
    code: options.errorCode ?? 'DEPLOYMENT_CAPABILITY_DENIED',
    statusCode: options.statusCode ?? 403,
    details: {
      profile: policy.profile,
      capabilities: [
        ...(options.capability ? [canonicalCapability(options.capability)] : []),
        ...(options.capabilities ?? []).map(canonicalCapability),
      ],
    },
  });
}

/** Creates an Express guard; asynchronous path checks are opt-in through `targetPath`. */
export function createDeploymentPolicyMiddleware(options: DeploymentPolicyMiddlewareOptions = {}): RequestHandler {
  const required = [
    ...(options.capability ? [options.capability] : []),
    ...(options.capabilities ?? []),
  ];
  // A function-valued policy is a startup source, not a request resolver.
  // Capture it while constructing the middleware so a later environment or
  // test-request mutation cannot change authorization for an already-mounted
  // route. When no explicit policy is supplied, retain the request snapshot
  // installed by the composition middleware (with the process environment as
  // the final legacy fallback).
  const capturedPolicy = options.policy === undefined
    ? undefined
    : captureDeploymentPolicy(options.policy);
  return (request: Request, _response: Response, next: NextFunction): void => {
    let policy: DeploymentPolicy;
    try {
      policy = resolvePolicy(capturedPolicy, request);
      const context = readDeploymentPolicyRequestContext(request);
      const requestWithPolicy = request as DeploymentPolicyRequest;
      requestWithPolicy.deploymentPolicy = policy;
      requestWithPolicy.deploymentPolicyContext = context;
      const profiles = options.profile === undefined
        ? options.profiles
        : options.profile;
      if (!isDeploymentProfile(policy, [...PROFILE_NAMES])
        || !required.every((capability) => hasDeploymentCapability(policy, capability))
        || (profiles !== undefined && !isDeploymentProfile(policy, profiles))) {
        next(deniedError(options, policy));
        return;
      }
      if (options.targetPath !== undefined) {
        void canonicalizeTargetPath(request, context, options).then(() => next(), next);
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Compatibility names used by route modules. */
export const createDeploymentPolicyGuard = createDeploymentPolicyMiddleware;
export const createDeploymentGuard = createDeploymentPolicyMiddleware;

/** Chooses a read or write capability according to an HTTP method. */
export function deploymentCapabilityForHttpMethod(
  readCapability: DeploymentCapability,
  writeCapability: DeploymentCapability,
  method: string,
): DeploymentCapability {
  return new Set(['GET', 'HEAD', 'OPTIONS']).has(method.toUpperCase()) ? readCapability : writeCapability;
}

/** Resolves an existing path and rejects symlink escapes from an optional root. */
export async function resolveCanonicalPath(
  candidatePath: string,
  options: { beneath?: string } = {},
): Promise<string> {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    throw new AppError('A non-empty candidate path is required.', {
      code: 'CANONICAL_PATH_REQUIRED',
      statusCode: 400,
    });
  }
  const candidate = await realpath(candidatePath);
  if (!options.beneath) return candidate;
  const root = await realpath(options.beneath);
  if (!isCanonicalPathInside(root, candidate)) {
    throw new AppError('Path is outside the permitted canonical root.', {
      code: 'PATH_OUTSIDE_CANONICAL_ROOT',
      statusCode: 403,
    });
  }
  return candidate;
}

/** Compares canonical paths using a separator boundary, not a string prefix. */
export function isCanonicalPathInside(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Short alias for callers that use the path helper as a canonicalizer. */
export const canonicalizePath = resolveCanonicalPath;
