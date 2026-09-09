import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import {
  findServerRoot,
  getModuleDirectory,
  readObjectRecord,
  readOptionalString,
  resolveCodexConfigPath,
} from '@/shared/utils.js';

type CcSwitchConfigDependencies = {
  readTextFile(pathname: string): Promise<string>;
  homeDirectory(): string;
};

/**
 * The non-secret provider fields required by the Codex SDK when a per-turn
 * config object overrides `model_providers`.  CC-Switch owns these values in
 * its generated TOML; credentials are deliberately not part of this shape.
 */
type CcSwitchCodexProviderConfiguration = {
  name: string;
  baseUrl: string;
  envKey: string;
  wireApi: string;
  requiresOpenaiAuth: boolean;
};

/** Snapshot of the non-secret values read from CC-Switch's Codex config. */
type CcSwitchCodexConfiguration = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  modelProvider?: string;
  providerConfiguration?: CcSwitchCodexProviderConfiguration;
  fastMode?: boolean;
  /** Sanitized host-owned MCP definitions safe to pass to the Codex SDK. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** Values moved out of MCP config so they never become CLI arguments. */
  mcpEnvironment?: Record<string, string>;
};

const CODEX_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODEX_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODEX_MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CODEX_MCP_APPROVAL_MODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const THINKINGDATA_MCP_HOST = 'admin-ss.gamehaus.com';
const THINKINGDATA_MCP_PATH_PREFIX = '/mcp/analysis/http/';
const THINKINGDATA_PROXY_SCRIPT = path.join(
  findServerRoot(getModuleDirectory(import.meta.url)),
  'modules/providers/list/claude/thinkingdata-mcp-compat-proxy.js',
);
const BROWSER_USE_MCP_SCRIPT_NAME = 'browser-use-mcp.js';
const BROWSER_USE_ENVIRONMENT_KEYS = new Set([
  'CLOUDCLI_BROWSER_USE_MCP_TOKEN',
  'CLOUDCLI_BROWSER_USE_API_URL',
]);

// Parsed TOML objects are ordinary JavaScript objects.  Treat these names as
// data-invalid rather than assigning them into a result map, where `__proto__`
// and friends could mutate the map's prototype or shadow an inherited value.
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const defaultDependencies: CcSwitchConfigDependencies = {
  readTextFile: (pathname) => readFile(pathname, 'utf8'),
  homeDirectory: () => os.homedir(),
};

const readStringRecord = (value: unknown): Record<string, string> => {
  const record = readObjectRecord(value) ?? {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
};

const readStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter((entry): entry is string => typeof entry === 'string');
  return values.length === value.length ? values : undefined;
};

const readFiniteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const makeMcpEnvironmentKey = (
  serverName: string,
  fieldName: string,
  usedKeys: Set<string>,
): string => {
  const base = `CLOUDCLI_MCP_${serverName}_${fieldName}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^([^A-Z_])/, '_$1')
    .slice(0, 180) || 'CLOUDCLI_MCP_VALUE';
  let candidate = base;
  let suffix = 2;
  while (usedKeys.has(candidate)) {
    candidate = `${base}_${suffix}`.slice(0, 200);
    suffix += 1;
  }
  usedKeys.add(candidate);
  return candidate;
};

const isThinkingDataMcpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === THINKINGDATA_MCP_HOST
      && parsed.pathname.startsWith(THINKINGDATA_MCP_PATH_PREFIX);
  } catch {
    return false;
  }
};

const buildThinkingDataCodexProxyConfig = (
  url: string,
  environment: NodeJS.ProcessEnv,
  configuredTokenEnvironmentName?: string,
  literalToken?: string,
  mcpEnvironment: Record<string, string> = {},
  usedEnvironmentKeys: Set<string> = new Set(),
): Record<string, unknown> => {
  const tokenFilePath = readOptionalString(environment.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE)
    ?? readOptionalString(environment.TE_MCP_TOKEN_FILE);
  let tokenEnvironmentName = configuredTokenEnvironmentName
    && CODEX_ENVIRONMENT_KEY_PATTERN.test(configuredTokenEnvironmentName)
    ? configuredTokenEnvironmentName
    : 'TE_MCP_TOKEN';
  if (literalToken) {
    tokenEnvironmentName = makeMcpEnvironmentKey('THINKINGDATA', 'MCP_TOKEN', usedEnvironmentKeys);
    mcpEnvironment[tokenEnvironmentName] = literalToken;
  }
  return {
    // Codex's HTTP transport currently rejects this ThinkingData endpoint as
    // unsupported. The same host-owned stdio compatibility proxy used by the
    // Claude runtime handles its stateless JSON-RPC and schema quirks.
    command: process.execPath,
    args: [THINKINGDATA_PROXY_SCRIPT],
    env: {
      CLOUDCLI_THINKINGDATA_MCP_URL: url,
      CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV: tokenEnvironmentName,
      ...(tokenFilePath
        ? { CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE: tokenFilePath }
        : {}),
    },
    env_vars: [
      tokenEnvironmentName,
      'TE_MCP_TOKEN_FILE',
      'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
    ],
  };
};

function isCloudCliBrowserMcpServer(
  serverName: string,
  command: string | undefined,
  args: string[] | undefined,
): boolean {
  // The registration is host-owned and always uses the stable server name.
  // Do not rely on an exact `process.execPath` match: launchd, npm, and a
  // bundled Node distribution can expose the same executable through
  // different absolute paths (or symlinks).  Requiring a Node-looking
  // command plus the managed script basename preserves the allow-list while
  // keeping arbitrary MCP commands on the generated alias path.
  return serverName === 'cloudcli-browser'
    && Boolean(command)
    && path.basename(command!).toLowerCase().startsWith('node')
    && args?.length === 1
    && path.basename(args[0]) === BROWSER_USE_MCP_SCRIPT_NAME;
}

/**
 * Normalizes host-owned Codex MCP definitions for both the CC-Switch reader
 * and Runtime Bridge's final SDK boundary. The function is intentionally
 * idempotent: a definition already rewritten to the ThinkingData stdio
 * compatibility proxy is returned unchanged, while a stale HTTP definition
 * is rewritten before it can reach a Codex binary that only accepts stdio.
 * Codex SDK serializes `config` as repeated `--config` command-line values,
 * so literal MCP credentials are moved to the child environment rather than
 * left in the SDK config object.
 */
export function sanitizeCodexMcpServers(
  value: unknown,
  processEnvironment: NodeJS.ProcessEnv,
): { servers: Record<string, Record<string, unknown>>; environment: Record<string, string> } {
  const source = readObjectRecord(value) ?? {};
  const servers: Record<string, Record<string, unknown>> = {};
  const mcpEnvironment: Record<string, string> = {};
  // Reserve the Browser executable's fixed names before generating aliases
  // for arbitrary MCP entries. The Browser child reads these names literally;
  // no other server may claim them through an alias collision.
  const usedEnvironmentKeys = new Set<string>(BROWSER_USE_ENVIRONMENT_KEYS);

  // Explicit env references are part of the input contract too. Reserve them
  // up front so an alias generated while visiting an earlier server cannot
  // shadow a name declared by a later server (or by a bearer/header mapping).
  for (const rawServer of Object.values(source)) {
    const server = readObjectRecord(rawServer);
    if (!server) {
      continue;
    }
    for (const key of readStringList(server.env_vars) ?? []) {
      if (CODEX_ENVIRONMENT_KEY_PATTERN.test(key)) {
        usedEnvironmentKeys.add(key);
      }
    }
    for (const key of Object.values(readStringRecord(server.env_http_headers))) {
      if (CODEX_ENVIRONMENT_KEY_PATTERN.test(key)) {
        usedEnvironmentKeys.add(key);
      }
    }
    const bearerTokenEnvVar = readOptionalString(server.bearer_token_env_var);
    if (bearerTokenEnvVar && CODEX_ENVIRONMENT_KEY_PATTERN.test(bearerTokenEnvVar)) {
      usedEnvironmentKeys.add(bearerTokenEnvVar);
    }
  }

  for (const [serverName, rawServer] of Object.entries(source)) {
    if (!CODEX_MCP_SERVER_NAME_PATTERN.test(serverName)
      || PROTOTYPE_POLLUTION_KEYS.has(serverName)) {
      continue;
    }
    const server = readObjectRecord(rawServer);
    if (!server) {
      continue;
    }

    const sanitized: Record<string, unknown> = {};
    const url = readOptionalString(server.url);
    const command = readOptionalString(server.command);
    const args = readStringList(server.args);
    // Runtime Bridge may receive the reader's already-normalized result from
    // a mocked/legacy config source. Do not reinterpret the proxy's literal
    // environment as generated variable names, or its child would lose the
    // names (URL/token env) that the proxy expects.
    if (
      command === process.execPath
      && args?.length === 1
      && path.basename(args[0]) === path.basename(THINKINGDATA_PROXY_SCRIPT)
    ) {
      servers[serverName] = server;
      continue;
    }
    const isBrowserMcpServer = isCloudCliBrowserMcpServer(serverName, command, args);
    if (url) {
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          continue;
        }
      } catch {
        continue;
      }
      if (isThinkingDataMcpUrl(url)) {
        const configuredTokenEnvironmentName = readStringRecord(server.env_http_headers)['mcp-token'];
        const literalToken = readStringRecord(server.http_headers)['mcp-token'];
        const proxyConfig = buildThinkingDataCodexProxyConfig(
          url,
          processEnvironment,
          configuredTokenEnvironmentName,
          literalToken,
          mcpEnvironment,
          usedEnvironmentKeys,
        );
        const enabledTools = readStringList(server.enabled_tools);
        if (enabledTools) {
          proxyConfig.enabled_tools = enabledTools;
        }
        const approvalMode = readOptionalString(server.default_tools_approval_mode);
        if (approvalMode && CODEX_MCP_APPROVAL_MODE_PATTERN.test(approvalMode)) {
          proxyConfig.default_tools_approval_mode = approvalMode;
        }
        for (const field of ['startup_timeout_sec', 'tool_timeout_sec'] as const) {
          const number = readFiniteNumber(server[field]);
          if (number !== undefined && number >= 0) {
            proxyConfig[field] = number;
          }
        }
        servers[serverName] = proxyConfig;
        continue;
      }
      sanitized.url = url;
    } else if (command) {
      sanitized.command = command;
    } else {
      continue;
    }

    if (args) {
      sanitized.args = args;
    }
    const cwd = readOptionalString(server.cwd);
    if (cwd && command) {
      sanitized.cwd = cwd;
    }

    const inheritedEnvVars = new Set(
      (readStringList(server.env_vars) ?? [])
        .filter((key) => CODEX_ENVIRONMENT_KEY_PATTERN.test(key)),
    );
    const literalEnvironment = readStringRecord(server.env);
    if (command) {
      for (const [key, literalValue] of Object.entries(literalEnvironment)) {
        if (!CODEX_ENVIRONMENT_KEY_PATTERN.test(key)) {
          continue;
        }
        // browser-use-mcp reads these two names directly. Preserve that
        // executable contract while still moving the literal values out of
        // the Codex config object and into the child environment.
        const environmentKey = isBrowserMcpServer && BROWSER_USE_ENVIRONMENT_KEYS.has(key)
          ? key
          : makeMcpEnvironmentKey(serverName, key, usedEnvironmentKeys);
        mcpEnvironment[environmentKey] = literalValue;
        inheritedEnvVars.add(environmentKey);
      }
      if (inheritedEnvVars.size > 0) {
        sanitized.env_vars = [...inheritedEnvVars];
      }
    }

    const envHttpHeaders = readStringRecord(server.env_http_headers);
    const safeEnvHttpHeaders: Record<string, string> = {};
    if (url) {
      for (const [headerName, configuredEnvName] of Object.entries(envHttpHeaders)) {
        if (
          CODEX_MCP_HEADER_NAME_PATTERN.test(headerName)
          && CODEX_ENVIRONMENT_KEY_PATTERN.test(configuredEnvName)
        ) {
          safeEnvHttpHeaders[headerName] = configuredEnvName;
        }
      }
    }

    const literalHeaders = readStringRecord(server.http_headers);
    if (url) {
      for (const [headerName, literalValue] of Object.entries(literalHeaders)) {
        if (!CODEX_MCP_HEADER_NAME_PATTERN.test(headerName)) {
          continue;
        }
        const generatedKey = makeMcpEnvironmentKey(serverName, headerName, usedEnvironmentKeys);
        mcpEnvironment[generatedKey] = literalValue;
        safeEnvHttpHeaders[headerName] = generatedKey;
      }
      if (Object.keys(safeEnvHttpHeaders).length > 0) {
        sanitized.env_http_headers = safeEnvHttpHeaders;
      }
    }

    const bearerTokenEnvVar = readOptionalString(server.bearer_token_env_var);
    if (url && bearerTokenEnvVar && CODEX_ENVIRONMENT_KEY_PATTERN.test(bearerTokenEnvVar)) {
      sanitized.bearer_token_env_var = bearerTokenEnvVar;
    }

    for (const field of ['startup_timeout_sec', 'tool_timeout_sec'] as const) {
      const number = readFiniteNumber(server[field]);
      if (number !== undefined && number >= 0) {
        sanitized[field] = number;
      }
    }
    const enabledTools = readStringList(server.enabled_tools);
    if (enabledTools) {
      sanitized.enabled_tools = enabledTools;
    }
    const approvalMode = readOptionalString(server.default_tools_approval_mode);
    if (approvalMode && CODEX_MCP_APPROVAL_MODE_PATTERN.test(approvalMode)) {
      sanitized.default_tools_approval_mode = approvalMode;
    }

    servers[serverName] = sanitized;
  }

  // Keep the two Browser names reserved even when a malformed/legacy entry
  // was encountered before the Browser server. This makes the invariant
  // explicit for future alias-generation changes and prevents a generated
  // alias from ever replacing the executable's fixed environment contract.
  return { servers, environment: mcpEnvironment };
}

/**
 * Reads the selected provider's non-secret Codex metadata.  Returning
 * `undefined` for an incomplete table lets Runtime Bridge fail closed with a
 * useful configuration error instead of passing a partial provider object to
 * the SDK (which otherwise reports an opaque "provider name must not be empty"
 * parse failure).
 */
function readCodexProviderConfiguration(
  value: unknown,
): CcSwitchCodexProviderConfiguration | undefined {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const name = readOptionalString(record.name);
  const baseUrl = readOptionalString(record.base_url);
  // Older Codex/CC-Switch files omit env_key for providers that use the
  // standard OpenAI-compatible credential variable.  Runtime Bridge injects
  // the fresh token under this name and still emits an explicit `env_key` so
  // the SDK receives a complete provider table.
  const configuredEnvKey = readOptionalString(record.env_key);
  const envKey = configuredEnvKey && CODEX_ENVIRONMENT_KEY_PATTERN.test(configuredEnvKey)
    ? configuredEnvKey
    : 'OPENAI_API_KEY';
  const wireApi = readOptionalString(record.wire_api);
  const requiresOpenaiAuth = record.requires_openai_auth;
  if (
    !name
    || !baseUrl
    || !wireApi
    || typeof requiresOpenaiAuth !== 'boolean'
  ) {
    return undefined;
  }

  return {
    name,
    baseUrl,
    envKey,
    wireApi,
    requiresOpenaiAuth,
  };
}

/**
 * Creates the CC-Switch configuration reader consumed by Runtime Bridge and
 * provider model catalogs. It reads CC-Switch's generated CLI files instead
 * of its private SQLite schema, so app upgrades cannot silently break this
 * integration and every new turn observes the latest provider switch.
 */
export function createCcSwitchConfigService(
  dependencyOverrides: Partial<CcSwitchConfigDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    async readCodexConfiguration(
      environment: NodeJS.ProcessEnv = process.env,
    ): Promise<CcSwitchCodexConfiguration | null> {
      const pathname = resolveCodexConfigPath(environment, dependencies.homeDirectory());

      try {
        const parsed = readObjectRecord(TOML.parse(await dependencies.readTextFile(pathname)));
        if (!parsed) {
          return null;
        }

        const features = readObjectRecord(parsed.features);
        const modelProvider = readOptionalString(parsed.model_provider);
        const modelProviders = readObjectRecord(parsed.model_providers);
        const providerConfiguration = modelProvider
          ? readCodexProviderConfiguration(modelProviders?.[modelProvider])
          : undefined;
        const mcp = sanitizeCodexMcpServers(parsed.mcp_servers, environment);

        return {
          model: readOptionalString(parsed.model),
          reasoningEffort: readOptionalString(parsed.model_reasoning_effort),
          serviceTier: readOptionalString(parsed.service_tier),
          modelProvider,
          ...(providerConfiguration ? { providerConfiguration } : {}),
          fastMode: features?.fast_mode === true,
          ...(Object.keys(mcp.servers).length > 0 ? { mcpServers: mcp.servers } : {}),
          ...(Object.keys(mcp.environment).length > 0
            ? { mcpEnvironment: mcp.environment }
            : {}),
        };
      } catch {
        return null;
      }
    },

    async readClaudeConfiguration(environment: NodeJS.ProcessEnv = process.env) {
      const pathname = environment.COMIC_CC_SWITCH_CLAUDE_SETTINGS_PATH?.trim()
        || path.join(dependencies.homeDirectory(), '.claude', 'settings.json');

      try {
        const parsed = readObjectRecord(JSON.parse(await dependencies.readTextFile(pathname)));
        if (!parsed) {
          return null;
        }

        const providerEnvironment = readStringRecord(parsed.env);
        const model = readOptionalString(providerEnvironment.ANTHROPIC_MODEL)
          ?? readOptionalString(providerEnvironment.ANTHROPIC_DEFAULT_SONNET_MODEL);
        const modelPicker = readObjectRecord(parsed.modelPicker);
        const modelOverrides = readObjectRecord(parsed.modelOverrides);

        return {
          environment: providerEnvironment,
          model,
          settings: {
            ...(modelPicker ? { modelPicker } : {}),
            ...(modelOverrides ? { modelOverrides } : {}),
          },
        };
      } catch {
        return null;
      }
    },
  };
}

/** Shared reader used by Runtime Bridge and provider model catalogs. */
export const ccSwitchConfigService = createCcSwitchConfigService();
