import type { ThreadOptions } from '@openai/codex-sdk';

type CodexRuntimePermissionOptions = {
  sandboxMode: NonNullable<ThreadOptions['sandboxMode']>;
  approvalPolicy: NonNullable<ThreadOptions['approvalPolicy']>;
  networkAccessEnabled?: ThreadOptions['networkAccessEnabled'];
  webSearchMode?: NonNullable<ThreadOptions['webSearchMode']>;
};

const CODEX_CONFIG_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODEX_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODEX_WIRE_API_PATTERN = /^[A-Za-z0-9_.-]+$/;
const CODEX_RESERVED_CONFIG_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readSafeString(value: unknown, pattern?: RegExp): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || /[\u0000\r\n]/.test(normalized)) {
    return undefined;
  }
  return pattern && !pattern.test(normalized) ? undefined : normalized;
}

function readSafeHttpUrl(value: unknown): string | undefined {
  const normalized = readSafeString(value);
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = new URL(normalized);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname
      || parsed.username
      || parsed.password
      // Query strings/fragments are not part of a model endpoint contract and
      // are a common place for an exported config to smuggle a bearer token.
      // The SDK serializes this URL into process arguments, so reject them
      // rather than risking credential disclosure in process listings/logs.
      || parsed.search
      || parsed.hash) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function readSafeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function sanitizeCodexProvider(value: unknown): Record<string, unknown> | null {
  const source = readRecord(value);
  const name = readSafeString(source.name);
  const baseUrl = readSafeHttpUrl(source.base_url);
  const envKey = readSafeString(source.env_key, CODEX_ENVIRONMENT_NAME_PATTERN);
  const wireApi = readSafeString(source.wire_api, CODEX_WIRE_API_PATTERN);
  if (!name || !baseUrl || !envKey || !wireApi
    || typeof source.requires_openai_auth !== 'boolean') {
    return null;
  }

  const sanitized: Record<string, unknown> = {
    name,
    base_url: baseUrl,
    env_key: envKey,
    wire_api: wireApi,
    requires_openai_auth: source.requires_openai_auth,
  };
  for (const key of [
    'request_max_retries',
    'stream_max_retries',
    'stream_idle_timeout_ms',
  ]) {
    const number = readSafeNonNegativeNumber(source[key]);
    if (number !== undefined) {
      sanitized[key] = number;
    }
  }
  return sanitized;
}

/**
 * Narrows a host-owned Codex config before a product/QA read-only turn.
 *
 * Codex's structured `config` object is flattened into repeated
 * `--config key=value` flags by the SDK.  A denylist is unsafe here because a
 * new CLI release can add an executable setting that the list does not know;
 * this allowlist keeps only model-routing metadata and retry knobs required to
 * reach the configured API.  Raw plugin, shell, sandbox, approval, network,
 * notification, and hook-related keys are intentionally omitted.  Curated
 * plugin and remote-plugin sync are explicitly disabled below so a read-only
 * Web turn cannot launch a background marketplace fetch; the caller still
 * supplies the SDK-managed read-only sandbox and web-search flags after this
 * object is built.  The normal developer bridge path still passes its
 * explicit MCP declarations; this helper's existing product/QA read-only
 * policy clears MCP commands separately. Local skills in the isolated
 * CODEX_HOME remain readable by Codex in either path.
 */
export function sanitizeCodexReadonlyConfig(value: unknown): Record<string, unknown> {
  const source = readRecord(value);
  const sanitized: Record<string, unknown> = {
    features: {
      // A failed provider must settle promptly; an unbounded retry policy can
      // leave a QA session looking permanently stuck.
      unbounded_connection_retries: false,
      // Do not run the curated marketplace/plugin synchronizer on every Web
      // turn. These flags do not disable local CODEX_HOME skills.
      plugins: false,
      remote_plugin: false,
    },
    // An empty table is intentional. Omitting `mcp_servers` would allow the
    // Codex binary to merge servers from an isolated HOME/config.toml that
    // was provisioned by another process. The explicit override clears that
    // inherited catalog before the thread starts.
    mcp_servers: {},
  };

  const modelProvider = readSafeString(source.model_provider, CODEX_CONFIG_NAME_PATTERN);
  if (modelProvider && !CODEX_RESERVED_CONFIG_NAMES.has(modelProvider.toLowerCase())) {
    sanitized.model_provider = modelProvider;
  }

  const serviceTier = readSafeString(source.service_tier, CODEX_CONFIG_NAME_PATTERN);
  if (serviceTier) {
    sanitized.service_tier = serviceTier;
  }

  const baseUrl = readSafeHttpUrl(source.openai_base_url);
  if (baseUrl) {
    sanitized.openai_base_url = baseUrl;
  }

  const sourceFeatures = readRecord(source.features);
  if (typeof sourceFeatures.fast_mode === 'boolean') {
    (sanitized.features as Record<string, unknown>).fast_mode = sourceFeatures.fast_mode;
  }

  const sourceProviders = readRecord(source.model_providers);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [providerName, providerValue] of Object.entries(sourceProviders)) {
    if (!CODEX_CONFIG_NAME_PATTERN.test(providerName)
      || CODEX_RESERVED_CONFIG_NAMES.has(providerName.toLowerCase())) {
      continue;
    }
    const sanitizedProvider = sanitizeCodexProvider(providerValue);
    if (sanitizedProvider) {
      providers[providerName] = sanitizedProvider;
    }
  }
  if (Object.keys(providers).length > 0) {
    sanitized.model_providers = providers;
  }

  return sanitized;
}

/**
 * Builds the narrowly scoped Codex client options used by the product/QA
 * readonly runtime.  The runtime bridge may carry fields added by a newer
 * SDK, so copying the whole object would make an unknown executable option a
 * policy bypass.  In particular, `codexPathOverride` is deliberately omitted:
 * it can point the SDK at an arbitrary host binary, whereas the managed
 * readonly deployment must use the version-pinned binary shipped with the
 * `@openai/codex-sdk` dependency.  The caller applies the final environment
 * filter and read-only thread flags after this helper returns.
 */
export function sanitizeCodexReadonlyClientOptions(value: unknown): Record<string, unknown> {
  const source = readRecord(value);
  const sanitized: Record<string, unknown> = {
    config: sanitizeCodexReadonlyConfig(source.config),
    configOverrides: stripCodexReadonlyConfigOverrides(source.configOverrides),
  };

  if (typeof source.apiKey === 'string') {
    const apiKey = readSafeString(source.apiKey);
    if (apiKey !== undefined) {
      sanitized.apiKey = apiKey;
    }
  }
  if (typeof source.baseUrl === 'string') {
    const baseUrl = readSafeHttpUrl(source.baseUrl);
    if (baseUrl !== undefined) {
      sanitized.baseUrl = baseUrl;
    }
  }
  if (source.env && typeof source.env === 'object' && !Array.isArray(source.env)) {
    sanitized.env = source.env;
  }

  return sanitized;
}

/**
 * Drops every raw Codex `--config` override in a read-only deployment.
 *
 * Raw overrides are deliberately not parsed with a denylist: they can use
 * whitespace, quoted TOML keys, nested dotted paths, or future config names to
 * reintroduce MCP/plugin/network/write capabilities.  The structured
 * allowlist above carries the only metadata this deployment needs.
 */
export function stripCodexReadonlyConfigOverrides(_value: unknown): string[] {
  return [];
}

/**
 * The Codex runtime consumes this mapping when it creates or resumes a thread;
 * focused provider tests consume it to lock down the workspace sandbox boundary.
 */
export function mapPermissionModeToCodexOptions(
  permissionMode: unknown,
): CodexRuntimePermissionOptions {
  switch (permissionMode) {
    case 'readonly':
    case 'read-only':
    case 'readOnly':
    case 'plan':
      return {
        // Codex's read-only sandbox rejects filesystem writes regardless of
        // prompt contents or tool approval state. Keep approval disabled so a
        // headless run cannot wait forever for an approval that the Web UI
        // intentionally does not expose in product/QA mode.
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
      };
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        // Keep filesystem writes scoped to the workspace while allowing tools
        // such as Git, package managers, and HTTP clients to reach the network.
        networkAccessEnabled: true,
        webSearchMode: 'live',
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        webSearchMode: 'live',
      };
    case 'default':
      return {
        sandboxMode: 'workspace-write',
        // The SDK drives `codex exec`, which is non-interactive and cannot
        // surface a shell approval request to CloudCLI. Keep that actual
        // behavior explicit instead of implying that `on-request` protects
        // the headless process. Filesystem writes remain workspace-scoped.
        approvalPolicy: 'never',
        networkAccessEnabled: true,
        webSearchMode: 'live',
      };
    default:
      // Permission modes originate in browser storage and cross a WebSocket
      // boundary. Never turn an unknown value into a more capable fallback.
      throw new TypeError(`Unsupported Codex permission mode: ${String(permissionMode)}`);
  }
}
