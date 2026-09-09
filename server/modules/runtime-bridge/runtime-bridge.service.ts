import { execFile } from 'node:child_process';
import path from 'node:path';

import {
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  type DeploymentEnvironment,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';

import {
  ccSwitchConfigService,
  sanitizeCodexMcpServers,
} from './cc-switch-config.service.js';

const TOKEN_HELPER_TIMEOUT_MS = 10_000;
const TOKEN_HELPER_MAX_BUFFER_BYTES = 16 * 1024;
const CODEX_MODEL_PROVIDER = 'dataverse';
const DEFAULT_CODEX_BASE_URL = 'https://ai-agent.dataverse.cn/v1';
const DEFAULT_CLAUDE_BASE_URL = 'https://ai-agent.dataverse.cn';
const CODEX_REQUEST_MAX_RETRIES = 2;
const CODEX_STREAM_MAX_RETRIES = 2;
// Allow a slow but healthy model/MCP stream up to the product-requested
// 180-second idle window before the child is considered unreachable.
const CODEX_STREAM_IDLE_TIMEOUT_MS = 180_000;
const VALID_CODEX_REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

type TokenHelperExecutionOptions = {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  shell: false;
  /**
   * Optional helper-only environment. This is used to point a credential
   * helper at its protected source directory while the provider child keeps
   * its isolated runtime HOME/CODEX_HOME.
   */
  env?: NodeJS.ProcessEnv;
};

type RuntimeBridgeDependencies = {
  getEnvironment(): NodeJS.ProcessEnv;
  executeTokenHelper(
    executablePath: string,
    args: string[],
    options: TokenHelperExecutionOptions,
  ): Promise<string>;
  readCcSwitchCodexConfiguration: typeof ccSwitchConfigService.readCodexConfiguration;
  readCcSwitchClaudeConfiguration: typeof ccSwitchConfigService.readClaudeConfiguration;
};

type CodexRuntimeBridge = {
  clientOptions: {
    apiKey?: string;
    env: Record<string, string>;
    codexPathOverride?: string;
    config: {
      model_provider?: string;
      service_tier?: string;
      features: {
        unbounded_connection_retries: boolean;
        /** Prevents Codex from starting a curated marketplace sync per turn. */
        plugins: boolean;
        /** Prevents remote curated plugin discovery/sync per turn. */
        remote_plugin: boolean;
        fast_mode?: boolean;
      };
      mcp_servers?: Record<string, Record<string, unknown>>;
      model_providers?: Record<string, {
        name: string;
        base_url: string;
        env_key: string;
        wire_api: string;
        requires_openai_auth: boolean;
        request_max_retries: number;
        stream_max_retries: number;
        stream_idle_timeout_ms: number;
      }>;
    };
    /** Raw overrides are emitted after `config`; used to replace inherited MCP tables. */
    configOverrides?: string[];
  };
  /** Sanitized host-owned MCP definitions for the interactive terminal path. */
  mcpServers?: Record<string, Record<string, unknown>>;
  model?: string;
  reasoningEffort?: string;
  usesGlobalConfig?: boolean;
};

type ClaudeRuntimeBridge = {
  env: Record<string, string>;
  model?: string;
  settings?: Record<string, unknown>;
};

type ClaudeRuntimeResolutionOptions = {
  omitSimpleMode?: boolean;
  /**
   * Marks a provider turn as belonging to the managed product/QA deployment.
   * Read-only turns do not execute a Dataverse/DSH credential helper unless
   * the deployment explicitly opts in with
   * `CLOUDCLI_READONLY_ALLOW_DATAVERSE_HELPER=1`.  This flag is supplied by
   * the server, never by a browser request.
   */
  deploymentReadOnly?: boolean;
  /**
   * Optional immutable environment snapshot supplied by a provider adapter.
   * Claude's fork compatibility path temporarily changes `process.env`, so
   * asynchronous bridge resolution must never retain the live environment
   * object across an await. This is an internal server value, not request data.
   */
  environment?: NodeJS.ProcessEnv;
};

type RuntimeBridgeResolutionOptions = ClaudeRuntimeResolutionOptions;

/**
 * Environment keys which select a deployment profile.  They are read once
 * when a bridge instance is created; request/turn options can only make a
 * runtime more restrictive and can never turn a managed process writable.
 */
const PROFILE_ENVIRONMENT_KEYS = [
  'CLOUDCLI_DEPLOYMENT_PROFILE',
  'DEPLOYMENT_PROFILE',
  'CLOUDCLI_PROFILE',
  'VITE_DEPLOYMENT_PROFILE',
] as const;

/** Explicit profiles intended for a local, writable developer/test process. */
const EXPLICIT_WRITABLE_PROFILES = new Set<DeploymentPolicy['profile']>([
  'developer',
  'development',
  'self-hosted',
  'test',
]);

const defaultDependencies: RuntimeBridgeDependencies = {
  getEnvironment: () => process.env,
  executeTokenHelper: (executablePath, args, options) => new Promise((resolve, reject) => {
    execFile(executablePath, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(String(stdout));
    });
  }),
  readCcSwitchCodexConfiguration: (environment) => (
    ccSwitchConfigService.readCodexConfiguration(environment)
  ),
  readCcSwitchClaudeConfiguration: (environment) => (
    ccSwitchConfigService.readClaudeConfiguration(environment)
  ),
};

function readNonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Reads a deployment-owned boolean switch.  Only an explicit affirmative
 * value enables the read-only Dataverse helper exception; every other value,
 * including malformed input, stays disabled (fail closed).
 */
function isTruthy(value: string | undefined): boolean {
  return value === '1';
}

/** Auth/deployment declarations accept the conventional env spellings. */
function isDeclaredTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function readExplicitProfile(environment: DeploymentEnvironment): string | undefined {
  return PROFILE_ENVIRONMENT_KEYS
    .map((key) => environment[key])
    .find((value) => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

/**
 * Resolve the immutable readonly posture for a bridge instance.
 *
 * The provider adapters normally pass `deploymentReadOnly` from the server's
 * startup policy.  The bridge is also used by legacy/alternate composition
 * roots, though, so trusting that per-call boolean alone would make a missed
 * flag reopen the Dataverse helper (and potentially an unsafe provider
 * configuration).  Derive a second, startup-owned floor here:
 *
 * - an explicit `product-qa-readonly` (or another capability-readonly
 *   managed profile) is always readonly;
 * - a DingTalk deployment with no explicit writable developer/test profile is
 *   readonly, including the implicit profile selected for a partial SSO
 *   configuration;
 * - an explicitly selected writable `developer`/`development`/`self-hosted`
 *   /`test` profile remains writable even when it is backed by DingTalk. This
 *   is the intentional local SSO development exception and is separately
 *   identity-gated by the auth/composition layers.
 *
 * Invalid profile configuration fails closed to readonly. The main server
 * startup parser still reports the configuration error; this fallback keeps
 * an embedded bridge from executing a helper while its profile is ambiguous.
 */
function resolveStartupReadonlyPosture(environment: DeploymentEnvironment): boolean {
  let policy: DeploymentPolicy;
  try {
    policy = parseDeploymentPolicy(environment);
  } catch {
    return true;
  }

  const explicitProfile = readExplicitProfile(environment);
  // A named developer/self-hosted profile is a writable exception only when
  // its resolved capability map still contains at least one mutating grant.
  // An operator can deliberately turn such a profile into a capability-level
  // readonly policy with `CLOUDCLI_DEPLOYMENT_CAPABILITIES`; that policy must
  // not accidentally retain helper execution just because its profile name
  // says `developer`.
  const explicitWritableProfile = explicitProfile !== undefined
    && EXPLICIT_WRITABLE_PROFILES.has(policy.profile)
    && !isDeploymentReadOnly(policy);
  const dingtalkDeclared = Boolean(
    environment.CLOUDCLI_DINGTALK_CREDENTIALS_FILE?.trim()
      || environment.CLOUDCLI_DINGTALK_PUBLIC_ORIGIN?.trim()
      || isDeclaredTruthy(environment.CLOUDCLI_REQUIRE_DINGTALK_AUTH),
  );

  return isDeploymentReadOnly(policy)
    || (dingtalkDeclared && !explicitWritableProfile);
}

function copyDefinedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const copiedEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') {
      copiedEnvironment[key] = value;
    }
  }
  return copiedEnvironment;
}

const CODEX_TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function formatCodexTomlKey(key: string): string {
  return CODEX_TOML_BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}

/**
 * Serializes the already-sanitized MCP table as one TOML inline value. The
 * Codex SDK applies raw `configOverrides` after its structured config, so the
 * caller can first clear inherited servers and then install this complete
 * host-owned table without leaving stale `url` fields behind.
 */
function formatCodexTomlValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatCodexTomlValue(entry)).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(([key, entry]) => `${formatCodexTomlKey(key)} = ${formatCodexTomlValue(entry)}`);
    return `{${fields.join(', ')}}`;
  }
  throw new Error('Unsupported sanitized Codex MCP value.');
}

function buildCodexMcpConfigOverride(
  servers: Record<string, Record<string, unknown>>,
): string {
  return `mcp_servers=${formatCodexTomlValue(servers)}`;
}

function omitClaudeSimpleMode(
  environment: Record<string, string>,
  shouldOmit: boolean | undefined,
): Record<string, string> {
  if (
    !shouldOmit
    || !Object.prototype.hasOwnProperty.call(environment, 'CLAUDE_CODE_SIMPLE')
  ) {
    return environment;
  }

  const webChatEnvironment = { ...environment };
  delete webChatEnvironment.CLAUDE_CODE_SIMPLE;
  return webChatEnvironment;
}

async function loadHelperToken(
  helperPath: string,
  environment: NodeJS.ProcessEnv,
  dependencies: RuntimeBridgeDependencies,
): Promise<string | undefined> {
  try {
    const helperEnvironment = resolveTokenHelperEnvironment(environment);
    const stdout = await dependencies.executeTokenHelper(helperPath, [], {
      encoding: 'utf8',
      timeout: TOKEN_HELPER_TIMEOUT_MS,
      maxBuffer: TOKEN_HELPER_MAX_BUFFER_BYTES,
      windowsHide: true,
      shell: false,
      ...(helperEnvironment ? { env: helperEnvironment } : {}),
    });
    return readNonEmpty(stdout);
  } catch {
    // Helper errors may contain stderr. Deliberately discard them so a token
    // or credential-service response can never be copied into application logs.
    return undefined;
  }
}

/**
 * Returns an environment for the credential helper without changing the
 * provider process environment.  Isolated CloudCLI candidates deliberately
 * set `CODEX_HOME` to a private transcript directory, but the operator's
 * helper may use `$CODEX_HOME/auth.json` as its protected credential source.
 * An explicit helper home wins; the CC-Switch config path is a safe fallback
 * because Codex stores `auth.json` beside its `config.toml`.  No credential is
 * read or copied here—the helper remains the only component that reads it.
 */
function resolveTokenHelperEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  const helperHome = readAbsoluteEnvironmentPath(
    environment.COMIC_DATAVERSE_TOKEN_HELPER_HOME,
  );
  const explicitCodexHome = readAbsoluteEnvironmentPath(
    environment.COMIC_DATAVERSE_TOKEN_HELPER_CODEX_HOME,
  );
  const switchConfigPath = readAbsoluteEnvironmentPath(
    environment.COMIC_CC_SWITCH_CODEX_CONFIG_PATH,
  );
  const inferredCodexHome = switchConfigPath
    && path.basename(switchConfigPath) === 'config.toml'
    ? path.dirname(switchConfigPath)
    : undefined;
  const helperCodexHome = explicitCodexHome ?? inferredCodexHome;
  const switchClaudeSettingsPath = readAbsoluteEnvironmentPath(
    environment.COMIC_CC_SWITCH_CLAUDE_SETTINGS_PATH,
  );
  const inferredClaudeHome = switchClaudeSettingsPath
    && path.basename(switchClaudeSettingsPath) === 'settings.json'
    && path.basename(path.dirname(switchClaudeSettingsPath)) === '.claude'
    ? path.dirname(path.dirname(switchClaudeSettingsPath))
    : undefined;
  const inferredHelperHome = helperHome ?? inferredClaudeHome;

  if (!inferredHelperHome && !helperCodexHome) {
    return undefined;
  }

  const helperEnvironment: NodeJS.ProcessEnv = { ...environment };
  if (inferredHelperHome) {
    helperEnvironment.HOME = inferredHelperHome;
  }
  if (helperCodexHome) {
    helperEnvironment.CODEX_HOME = helperCodexHome;
  }
  return helperEnvironment;
}

/**
 * Accepts only absolute, control-character-free deployment paths for helper
 * overrides. Relative values are ignored so a request or working directory
 * cannot redirect the credential helper to an unexpected location.
 */
function readAbsoluteEnvironmentPath(value: string | undefined): string | undefined {
  const normalized = readNonEmpty(value);
  if (!normalized || /[\u0000\r\n]/.test(normalized) || !path.isAbsolute(normalized)) {
    return undefined;
  }
  return path.resolve(normalized);
}

async function resolveToken(
  environment: NodeJS.ProcessEnv,
  fallbackKeys: string[],
  dependencies: RuntimeBridgeDependencies,
  options: {
    /**
     * Allows a deployment-owned provider configuration to use a credential
     * already present in the service environment when no helper is installed.
     * This must only be enabled after the caller has established an explicit
     * bridge configuration; a bare ambient API key must not silently switch
     * the stock provider to Dataverse.
     */
    allowEnvironmentFallback?: boolean;
    /**
     * Controls execution of the deployment-owned credential helper. A
     * read-only product/QA turn sets this from the startup deployment
     * boundary; it must not be inferred from request data.
     */
    allowCredentialHelper?: boolean;
  } = {},
): Promise<string | null> {
  const helperPath = readNonEmpty(environment.COMIC_DATAVERSE_TOKEN_HELPER);
  const helperEnabled = Boolean(helperPath) && options.allowCredentialHelper !== false;
  if (!helperEnabled) {
    // A disabled helper must not turn an ambient provider key into a
    // Dataverse bridge accidentally.  Direct credentials are accepted only
    // when the caller also supplied an explicit bridge declaration (or a
    // CC-Switch provider snapshot, which is passed as allowEnvironmentFallback).
    if (!options.allowEnvironmentFallback) {
      return null;
    }

    for (const fallbackKey of fallbackKeys) {
      const fallbackToken = readNonEmpty(environment[fallbackKey]);
      if (fallbackToken) {
        return fallbackToken;
      }
    }

    return null;
  }

  // `helperPath` is known to be non-empty when helper execution is enabled;
  // keep the guard explicit so a future refactor cannot pass `undefined` to
  // the subprocess boundary.
  const helperToken = await loadHelperToken(helperPath!, environment, dependencies);
  if (helperToken) {
    return helperToken;
  }

  for (const fallbackKey of fallbackKeys) {
    const fallbackToken = readNonEmpty(environment[fallbackKey]);
    if (fallbackToken) {
      return fallbackToken;
    }
  }

  // Keep this error intentionally generic. The provider adapter logs errors,
  // so neither the helper path nor its stderr may be attached as a cause.
  throw new Error('Dataverse runtime credentials are unavailable.');
}

function readCodexReasoningEffort(environment: NodeJS.ProcessEnv): string | undefined {
  const effort = readNonEmpty(environment.COMIC_CODEX_REASONING_EFFORT);
  return effort && VALID_CODEX_REASONING_EFFORTS.has(effort) ? effort : undefined;
}

function normalizeCodexReasoningEffort(value: string | undefined): string | undefined {
  return value && VALID_CODEX_REASONING_EFFORTS.has(value) ? value : undefined;
}

function isCcSwitchSyncEnabled(environment: NodeJS.ProcessEnv): boolean {
  return ['1', 'true', 'yes'].includes(
    environment.COMIC_CC_SWITCH_SYNC?.trim().toLowerCase() ?? '',
  );
}

/**
 * Identifies an operator-owned Codex bridge declaration.  A provider URL or
 * model is an explicit opt-in to the Dataverse bridge; a standalone
 * `OPENAI_API_KEY`/`CODEX_API_KEY` remains available to the stock Codex SDK
 * and does not activate a different endpoint by accident.
 */
function hasExplicitCodexBridgeConfiguration(environment: NodeJS.ProcessEnv): boolean {
  return isCcSwitchSyncEnabled(environment)
    || Boolean(
      readNonEmpty(environment.COMIC_CODEX_BASE_URL)
      || readNonEmpty(environment.COMIC_CODEX_MODEL),
    );
}

/**
 * Identifies an operator-owned Claude bridge declaration.  A helper alone is
 * not enough when its execution is disabled for a read-only turn: an ambient
 * Anthropic key must not silently select the Dataverse endpoint.  Explicit
 * COMIC_CLAUDE_* routing values (or CC-Switch, handled separately) are the
 * deployment opt-in that makes a direct credential fallback meaningful.
 */
function hasExplicitClaudeBridgeConfiguration(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    readNonEmpty(environment.COMIC_CLAUDE_BASE_URL)
    || readNonEmpty(environment.COMIC_CLAUDE_MODEL),
  );
}

/**
 * Dataverse is an authenticated OpenAI-compatible endpoint.  Some older
 * CC-Switch exports incorrectly recorded `requires_openai_auth = false`;
 * keeping that value in a per-turn override makes the provider declaration
 * claim that an unauthenticated request is valid.  Do not rewrite unrelated
 * custom providers, which may intentionally support anonymous requests.
 */
function requiresOpenaiAuth(providerConfiguration: {
  name: string;
  baseUrl: string;
  requiresOpenaiAuth: boolean;
}): boolean {
  if (providerConfiguration.requiresOpenaiAuth) {
    return true;
  }

  try {
    const hostname = new URL(providerConfiguration.baseUrl).hostname.toLowerCase();
    return hostname === 'ai-agent.dataverse.cn'
      || providerConfiguration.name.trim().toLowerCase() === 'dataverse';
  } catch {
    return providerConfiguration.name.trim().toLowerCase() === 'dataverse';
  }
}

/**
 * Used by the Codex and Claude provider adapters to construct an isolated,
 * per-turn Dataverse configuration without persisting or logging credentials.
 * The factory is also consumed by focused module tests so subprocess execution
 * and environment changes can be verified without invoking a real helper.
 */
export function createDataverseRuntimeBridgeService(
  dependencyOverrides: Partial<RuntimeBridgeDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const startupEnvironment = dependencies.getEnvironment();
  // Capture the deployment posture at bridge construction, which is the
  // server's module/startup boundary.  Provider config and credentials remain
  // intentionally fresh per turn, but a later mutation of process.env (or a
  // request-shaped object in an alternate embedder) cannot turn a managed
  // readonly bridge into a helper-executing writable one.
  const startupReadonly = resolveStartupReadonlyPosture(startupEnvironment);
  // The exception is also startup-only.  Reading this switch on every turn
  // would let a request-adjacent environment mutation enable a credential
  // helper after the process had already been admitted as read-only.
  const startupReadonlyHelperOptIn = isTruthy(
    startupEnvironment.CLOUDCLI_READONLY_ALLOW_DATAVERSE_HELPER,
  );

  return {
    isConfigured(options: RuntimeBridgeResolutionOptions = {}): boolean {
      const environment = options.environment
        ? copyDefinedEnvironment(options.environment)
        : copyDefinedEnvironment(dependencies.getEnvironment());
      const deploymentReadOnly = options.deploymentReadOnly === true
        || startupReadonly;
      const helperAllowed = !deploymentReadOnly
        || startupReadonlyHelperOptIn;
      return hasExplicitCodexBridgeConfiguration(environment)
        || (helperAllowed && Boolean(readNonEmpty(environment.COMIC_DATAVERSE_TOKEN_HELPER)));
    },

    async resolveCodexRuntime(
      options: RuntimeBridgeResolutionOptions = {},
    ): Promise<CodexRuntimeBridge | null> {
      // Copy synchronously before any helper/config await. A Claude fork may
      // temporarily mutate process.env for SDK compatibility in the same
      // process; retaining the live object would make this turn inherit that
      // unrelated config root or credentials.
      const environment = options.environment
        ? copyDefinedEnvironment(options.environment)
        : copyDefinedEnvironment(dependencies.getEnvironment());
      const deploymentReadOnly = options.deploymentReadOnly === true
        || startupReadonly;
      const allowCredentialHelper = !deploymentReadOnly
        || startupReadonlyHelperOptIn;
      if (isCcSwitchSyncEnabled(environment)) {
        const ccSwitchConfiguration = await dependencies.readCcSwitchCodexConfiguration(environment);
        if (!ccSwitchConfiguration) {
          throw new Error('CC-Switch Codex configuration is unavailable.');
        }

        // Read the selected provider before resolving credentials. CC-Switch
        // permits a provider to declare a non-standard env key (for example
        // `DATAVERSE_API_TOKEN`); that key is an explicit part of the trusted
        // provider snapshot and must be accepted as a direct fallback when a
        // helper is unavailable.
        const providerName = ccSwitchConfiguration.modelProvider;
        const providerConfiguration = ccSwitchConfiguration.providerConfiguration;
        if (providerName && !providerConfiguration) {
          throw new Error('CC-Switch Codex provider configuration is incomplete.');
        }
        const credentialFallbackKeys = [
          'OPENAI_API_KEY',
          'CODEX_API_KEY',
          ...(providerConfiguration?.envKey ? [providerConfiguration.envKey] : []),
        ];

        const token = await resolveToken(
          environment,
          credentialFallbackKeys,
          dependencies,
          { allowEnvironmentFallback: true, allowCredentialHelper },
        );
        const codexPathOverride = readNonEmpty(environment.COMIC_CODEX_CLI_PATH);
        const reasoningEffort = normalizeCodexReasoningEffort(
          ccSwitchConfiguration.reasoningEffort,
        );
        const tokenEnvironment: Record<string, string> = token && providerConfiguration
          ? {
            OPENAI_API_KEY: token,
            [providerConfiguration.envKey]: token,
          }
          : token
            ? { OPENAI_API_KEY: token }
            : {};
        // Keep this normalization at the SDK boundary as well as in the
        // config reader. A legacy/mocked reader or an out-of-date candidate
        // build must not reintroduce ThinkingData `url` entries that Codex
        // parses as stdio and rejects before the model turn starts.
        const normalizedMcp = ccSwitchConfiguration.mcpServers
          ? sanitizeCodexMcpServers(ccSwitchConfiguration.mcpServers, environment)
          : null;

        return {
          clientOptions: {
            ...(token ? { apiKey: token } : {}),
            env: {
              ...copyDefinedEnvironment(environment),
              ...(ccSwitchConfiguration.mcpEnvironment ?? {}),
              ...(normalizedMcp?.environment ?? {}),
              ...tokenEnvironment,
            },
            ...(codexPathOverride ? { codexPathOverride } : {}),
            config: {
              ...(providerName ? { model_provider: providerName } : {}),
              ...(ccSwitchConfiguration.serviceTier
                ? { service_tier: ccSwitchConfiguration.serviceTier }
                : {}),
              features: {
                unbounded_connection_retries: false,
                // CloudCLI keeps MCP declarations and the operator's local
                // CODEX_HOME skills, but must not let every Web turn start a
                // background curated marketplace/plugin fetch.
                plugins: false,
                remote_plugin: false,
                ...(ccSwitchConfiguration.fastMode ? { fast_mode: true } : {}),
              },
              // Emit an empty structured table first. Codex merges structured
              // overrides with the user's CODEX_HOME config; this prevents an
              // inherited HTTP ThinkingData entry from being combined with
              // our stdio proxy definition.
              mcp_servers: {},
              ...(providerName && providerConfiguration
                ? {
                  model_providers: {
                    [providerName]: {
                      name: providerConfiguration.name,
                      base_url: providerConfiguration.baseUrl,
                      env_key: providerConfiguration.envKey,
                      wire_api: providerConfiguration.wireApi,
                      requires_openai_auth: requiresOpenaiAuth(providerConfiguration),
                      request_max_retries: CODEX_REQUEST_MAX_RETRIES,
                      stream_max_retries: CODEX_STREAM_MAX_RETRIES,
                      stream_idle_timeout_ms: CODEX_STREAM_IDLE_TIMEOUT_MS,
                    },
                  },
                }
                : {}),
              },
            ...(normalizedMcp && Object.keys(normalizedMcp.servers).length > 0
              ? { configOverrides: [buildCodexMcpConfigOverride(normalizedMcp.servers)] }
              : {}),
          },
          ...(normalizedMcp && Object.keys(normalizedMcp.servers).length > 0
            ? { mcpServers: normalizedMcp.servers }
            : {}),
          ...(ccSwitchConfiguration.model ? { model: ccSwitchConfiguration.model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          usesGlobalConfig: true,
        };
      }

      const token = await resolveToken(
        environment,
        ['OPENAI_API_KEY', 'CODEX_API_KEY'],
        dependencies,
        {
          allowEnvironmentFallback: hasExplicitCodexBridgeConfiguration(environment),
          allowCredentialHelper,
        },
      );
      if (!token) {
        return null;
      }

      const baseUrl = readNonEmpty(environment.COMIC_CODEX_BASE_URL)
        ?? DEFAULT_CODEX_BASE_URL;
      const model = readNonEmpty(environment.COMIC_CODEX_MODEL);
      const reasoningEffort = readCodexReasoningEffort(environment);
      const codexPathOverride = readNonEmpty(environment.COMIC_CODEX_CLI_PATH);

      return {
        clientOptions: {
          apiKey: token,
          env: {
            ...copyDefinedEnvironment(environment),
            OPENAI_API_KEY: token,
          },
          ...(codexPathOverride ? { codexPathOverride } : {}),
          config: {
            model_provider: CODEX_MODEL_PROVIDER,
            // A Dataverse transport failure must settle so CloudCLI can release
            // the run and a later user retry starts with a fresh HTTP client.
            // Codex's unbounded reconnect backoff can otherwise hold a failed
            // process for many minutes and make healthy new requests look stuck.
            features: {
              unbounded_connection_retries: false,
              // Disable Codex's curated marketplace sync for each Web turn.
              // Explicit MCP servers and local CODEX_HOME skills remain
              // available; only the background plugin fetch is suppressed.
              plugins: false,
              remote_plugin: false,
            },
            model_providers: {
              [CODEX_MODEL_PROVIDER]: {
                name: 'Dataverse',
                base_url: baseUrl,
                env_key: 'OPENAI_API_KEY',
                wire_api: 'responses',
                requires_openai_auth: true,
                request_max_retries: CODEX_REQUEST_MAX_RETRIES,
                stream_max_retries: CODEX_STREAM_MAX_RETRIES,
                stream_idle_timeout_ms: CODEX_STREAM_IDLE_TIMEOUT_MS,
              },
            },
          },
        },
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
    },

    async resolveClaudeRuntime(
      options: ClaudeRuntimeResolutionOptions = {},
    ): Promise<ClaudeRuntimeBridge | null> {
      // Take a value snapshot before the first await. The SDK fork adapter
      // uses a short-lived process.env override, and a live reference here
      // would otherwise observe the override halfway through resolution.
      const environment = options.environment
        ? copyDefinedEnvironment(options.environment)
        : copyDefinedEnvironment(dependencies.getEnvironment());
      const deploymentReadOnly = options.deploymentReadOnly === true
        || startupReadonly;
      const allowCredentialHelper = !deploymentReadOnly
        || startupReadonlyHelperOptIn;
      if (isCcSwitchSyncEnabled(environment)) {
        const ccSwitchConfiguration = await dependencies.readCcSwitchClaudeConfiguration(environment);
        if (!ccSwitchConfiguration) {
          throw new Error('CC-Switch Claude configuration is unavailable.');
        }

        // CC-Switch owns the provider URL/model/settings, but credentials must
        // still be resolved through the same per-turn helper as Codex.  A
        // settings.json copied from another provider/account can otherwise
        // leave Claude Web sending a stale API key and receiving opaque 400s.
        // Merge the switch environment as the fallback source so an explicit
        // helper remains authoritative while a standalone CC-Switch setup
        // keeps working when no helper is configured.
        const credentialEnvironment = {
          ...copyDefinedEnvironment(environment),
          ...ccSwitchConfiguration.environment,
        };
        const token = await resolveToken(
          credentialEnvironment,
          ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
          dependencies,
          {
            allowCredentialHelper,
            // CC-Switch is itself an explicit provider declaration.  If the
            // helper is disabled for readonly, an operator-supplied token in
            // that snapshot may still be used without invoking the helper.
            allowEnvironmentFallback: true,
          },
        );
        const configDirectory = readNonEmpty(environment.COMIC_CLAUDE_CONFIG_DIR);
        const switchEnvironment = {
          ...ccSwitchConfiguration.environment,
          ...(token
            ? {
              ANTHROPIC_AUTH_TOKEN: token,
              ANTHROPIC_API_KEY: token,
            }
            : {}),
        };
        return {
          env: omitClaudeSimpleMode({
            ...copyDefinedEnvironment(environment),
            ...switchEnvironment,
            ...(configDirectory ? { CLAUDE_CONFIG_DIR: configDirectory } : {}),
          }, options.omitSimpleMode),
          ...(ccSwitchConfiguration.model ? { model: ccSwitchConfiguration.model } : {}),
          ...(Object.keys(ccSwitchConfiguration.settings).length > 0
            ? { settings: ccSwitchConfiguration.settings }
            : {}),
        };
      }

      const token = await resolveToken(
        environment,
        ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
        dependencies,
        {
          allowCredentialHelper,
          allowEnvironmentFallback: hasExplicitClaudeBridgeConfiguration(environment),
        },
      );
      if (!token) {
        return null;
      }

      const baseUrl = readNonEmpty(environment.COMIC_CLAUDE_BASE_URL)
        ?? DEFAULT_CLAUDE_BASE_URL;
      const model = readNonEmpty(environment.COMIC_CLAUDE_MODEL);
      const configDirectory = readNonEmpty(environment.COMIC_CLAUDE_CONFIG_DIR);
      const runtimeEnvironment = omitClaudeSimpleMode({
        ...copyDefinedEnvironment(environment),
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: token,
        ...(configDirectory ? { CLAUDE_CONFIG_DIR: configDirectory } : {}),
        ...(model
          ? {
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          }
          : {}),
      }, options.omitSimpleMode);

      return {
        env: runtimeEnvironment,
        ...(model ? { model } : {}),
      };
    },
  };
}

/** Used by the Codex and Claude provider adapters for per-turn pilot configuration. */
export const dataverseRuntimeBridgeService = createDataverseRuntimeBridgeService();
