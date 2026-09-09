import path from 'node:path';

/**
 * The subset of Claude SDK options that the Web adapter hardens.  The
 * JavaScript runtime may carry additional SDK fields; the explicitly listed
 * executable extensions are the ones this helper must remove in a read-only
 * deployment.
 */
export type ClaudeWebSdkOptions = {
  env?: Record<string, string | undefined>;
  settings?: string | object;
  /**
   * Policy-tier settings passed through the SDK's `--managed-settings` flag.
   * Keep this broad for compatibility with the SDK's generated `Settings`
   * interface (which changes as Claude Code adds policy keys).  The readonly
   * path always replaces the value with a fresh, server-owned object; the
   * developer path leaves a caller-provided value untouched.
   */
  managedSettings?: object;
  // Kept broad because this helper accepts SDK option objects assembled by
  // callers; the value is normalized to the allowlisted project source below.
  settingSources?: string[];
  strictMcpConfig?: boolean;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: unknown;
  disallowedTools?: unknown;
  plugins?: unknown[];
  hooks?: unknown;
  agents?: unknown;
  agent?: unknown;
  additionalDirectories?: unknown;
  extraArgs?: unknown;
  toolAliases?: unknown;
  skills?: unknown;
  sandbox?: unknown;
  allowDangerouslySkipPermissions?: unknown;
  permissionMode?: unknown;
  mcpServers?: unknown;
};

/**
 * Built-in Claude tools exposed to product/QA read-only turns.  WebFetch and
 * WebSearch are intentionally absent: the 0.78 deployment must not gain an
 * outbound web capability merely because a model asks for it.  Passing this
 * exact array to the SDK also prevents a future built-in tool from being
 * enabled by the broad `claude_code` preset.
 */
export const CLAUDE_READ_ONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoRead',
] as const;

const CLAUDE_READ_ONLY_DENIED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Task',
  'KillShell',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'Skill',
  'SlashCommand',
  'Agent',
  'mcp__*',
] as const;

/**
 * Security posture selected by the CloudCLI deployment boundary.
 *
 * The helper historically always applied the isolated Web/readonly posture,
 * so `readOnly` defaults to `true` for callers that use the one-argument
 * compatibility API.  Developer deployments pass `{ readOnly: false }` (or
 * simply skip this helper) to preserve Claude Code's native user/local
 * settings, skills, plugins, and MCP scopes.
 */
export type ClaudeWebRuntimeSecurityOptions = {
  readOnly?: boolean;
  /**
   * Server-owned directories that a read-only turn may inspect in addition to
   * its project working directory.  This is intentionally a separate option
   * from the caller's SDK `additionalDirectories`: request/config values are
   * never copied into it.  CloudCLI uses it for the private attachment store
   * so a normal file attachment can be read without reopening the rest of the
   * service account home.
   */
  readOnlyAdditionalDirectories?: readonly string[];
};

const CLAUDE_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readSafeSettingsString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\u0000\r\n]/.test(value)) {
    return undefined;
  }
  return value;
}

function readSettingsEnvironment(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => (
      CLAUDE_ENVIRONMENT_KEY_PATTERN.test(entry[0])
      && typeof entry[1] === 'string'
      && !/[\u0000\r\n]/.test(entry[1])
    )),
  );
}

function isSafeModelEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

const CLAUDE_READ_ONLY_SETTINGS_ENV_EXACT_KEYS = new Set([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]);

/**
 * Settings `env` is serialized into the child before Claude starts. Keep only
 * the explicit model endpoint/credential values; reject shell startup hooks,
 * proxy routing, dynamic loader paths, cloud-provider selectors,
 * transport sockets, Claude feature toggles, and arbitrary credential names
 * that could become an execution side channel.
 */
function filterClaudeSettingsEnvironment(value: unknown): Record<string, string> {
  const source = readSettingsEnvironment(value);
  const filtered: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    const upperKey = key.toUpperCase();
    if (CLAUDE_READ_ONLY_SETTINGS_ENV_EXACT_KEYS.has(upperKey)) {
      if (upperKey === 'ANTHROPIC_BASE_URL' && !isSafeModelEndpoint(entry)) {
        continue;
      }
      filtered[key] = entry;
    }
  }
  return filtered;
}

function readSettingsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readSettingsStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => readSafeSettingsString(entry) !== undefined);
}

/**
 * Keeps the additional read roots a narrow, trusted runtime input.  The
 * composition root supplies these paths; nevertheless reject relative,
 * malformed, and filesystem-root values so an accidental future call cannot
 * turn the read-only SDK into a machine-wide browser.
 */
function normalizeReadOnlyAdditionalDirectories(
  value: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const directories = value.flatMap((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || /[\u0000\r\n]/.test(entry)) {
      return [];
    }
    const normalized = entry.trim();
    if (!path.isAbsolute(normalized) || path.parse(normalized).root === normalized) {
      return [];
    }
    return [path.resolve(normalized)];
  });

  return [...new Set(directories)];
}

/**
 * Settings supplied through `--settings` are a JSON object, but the Claude
 * schema intentionally contains many command/plugin/agent extension points.
 * Keep model-routing data only; copying unknown keys here would let a future
 * CLI release turn an otherwise harmless bridge field into an executable
 * channel before the tool allowlist runs.
 */
function readSafeStringMap(value: unknown): Record<string, string> {
  const source = readSettingsRecord(value);
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(source)) {
    if (
      key === '__proto__'
      || key === 'constructor'
      || key === 'prototype'
    ) {
      continue;
    }
    const safeValue = readSafeSettingsString(rawValue);
    if (safeValue !== undefined) {
      result[key] = safeValue;
    }
  }
  return result;
}

function readSafeModelPicker(value: unknown): Record<string, unknown> | undefined {
  const source = readSettingsRecord(value);
  if (!Array.isArray(source.options)) {
    return undefined;
  }

  const options = source.options.flatMap((entry) => {
    const row = readSettingsRecord(entry);
    const model = readSafeSettingsString(row.model);
    if (model === undefined) {
      return [];
    }
    const safeRow: Record<string, string> = { model };
    for (const key of ['label', 'description', 'behavesAs']) {
      const safeValue = readSafeSettingsString(row[key]);
      if (safeValue !== undefined) {
        safeRow[key] = safeValue;
      }
    }
    return [safeRow];
  });

  return {
    options,
    ...(typeof source.replaceBuiltInOptions === 'boolean'
      ? { replaceBuiltInOptions: source.replaceBuiltInOptions }
      : {}),
  };
}

function copySafeClaudeSettings(source: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  const environment = readSettingsEnvironment(source.env);
  if (Object.keys(environment).length > 0) {
    safe.env = environment;
  }

  for (const key of ['model', 'serviceTier']) {
    const value = readSafeSettingsString(source[key]);
    if (value !== undefined) {
      safe[key] = value;
    }
  }
  for (const key of ['fallbackModel', 'availableModels']) {
    if (Array.isArray(source[key])) {
      const values = readSettingsStringList(source[key]);
      safe[key] = values;
    }
  }
  if (typeof source.enforceAvailableModels === 'boolean') {
    safe.enforceAvailableModels = source.enforceAvailableModels;
  }

  const modelOverrides = readSafeStringMap(source.modelOverrides);
  if (Object.keys(modelOverrides).length > 0) {
    safe.modelOverrides = modelOverrides;
  }
  const modelPicker = readSafeModelPicker(source.modelPicker);
  if (modelPicker) {
    safe.modelPicker = modelPicker;
  }
  return safe;
}

/**
 * Build the policy-tier portion of the readonly contract.
 *
 * Claude Agent SDK 0.3.258 serializes `Options.managedSettings` as
 * `--managed-settings <JSON>`.  The CLI then applies a restrictive-only
 * filter to this parent tier.  Consequently, the `allowManaged*` locks and
 * restrictive permission fields below are the fields that are guaranteed to
 * survive that filter; the explicit disable flags are included as a
 * compatibility layer for CLI versions that honor them directly from the
 * SDK-provided policy tier.  The same flags are also retained in
 * `options.settings` below, which is the high-priority flag-settings layer.
 *
 * Do not copy model credentials or arbitrary caller settings here.  Managed
 * settings are policy-only and must never become a second credential/config
 * channel.  `additionalDirectories` is limited to the server-owned asset
 * roots already normalized by this module.
 */
function buildReadOnlyManagedSettings(
  deniedTools: readonly string[],
  additionalDirectories: readonly string[],
): Record<string, unknown> {
  return {
    // These locks are explicitly supported in the SDK's restrictive parent
    // filter and prevent lower-precedence settings/CLI flags from reopening
    // hooks, permission allows, MCP, or non-plugin customization surfaces.
    allowManagedHooksOnly: true,
    allowManagedPermissionRulesOnly: true,
    allowManagedMcpServersOnly: true,
    strictPluginOnlyCustomization: true,

    // Policy keys are duplicated here for SDK/CLI compatibility.  Current
    // versions honor the restrictive `allowManaged*` locks above even when a
    // particular disable key is not retained by the parent-tier filter.
    disableAllHooks: true,
    disableAgentView: true,
    disableRemoteControl: true,
    disableWorkflows: true,
    enableWorkflows: false,
    disableSkillShellExecution: true,
    disableArtifact: true,
    enableArtifact: false,
    disableClaudeAiConnectors: true,
    disableCommandPluginSources: true,
    disableSideloadFlags: true,
    disableBundledSkills: true,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,

    // An empty managed allowlist plus the lock above means no MCP server can
    // be introduced by a repository/user settings file.  `strictMcpConfig`
    // and `mcpServers: {}` are applied on the SDK options as a second layer.
    allowedMcpServers: [],
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: [],

    permissions: {
      // `deny`/`ask`, bypass disabling, and read-root blocking are all
      // restrictive keys retained by the SDK managed-settings filter.
      deny: [...deniedTools],
      ask: [],
      disableBypassPermissionsMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
      // This is intentionally a server-owned list.  The SDK may drop it when
      // allowManagedPermissionRulesOnly is active (because it is permissive),
      // while older CLIs can still use it to permit attachment reads.
      additionalDirectories: [...additionalDirectories],
    },
  };
}

/**
 * Used by the Claude Web provider to keep the embedded CLI on its full-tool
 * path and to make SDK-supplied MCP servers the only executable MCP source.
 *
 * Removing `CLAUDE_CODE_SIMPLE` from the child environment handles host and
 * per-request values. The empty value in SDK `settings` is equally important:
 * the SDK serializes that object as the highest-priority user-controlled
 * `--settings` layer, so it shadows values reintroduced by user, project, or
 * local `settings.json` files; Claude drops empty settings env values instead
 * of exporting them. Managed policy remains intentionally authoritative.
 *
 * `strictMcpConfig` prevents a repository's `.mcp.json` from being discovered
 * alongside the explicitly supplied, host-owned user MCP definitions. This is
 * fail-closed until CloudCLI has a first-class workspace trust and per-server
 * approval flow that can safely expose project/local MCP scopes in Web Chat.
 *
 * Readonly turns also disable every SDK extension that can execute a command,
 * launch a background agent, open a remote-control channel, or load a plugin
 * supplied by a filesystem settings layer. `settingSources: []` is deliberate:
 * project settings may contain hooks/plugins and the SDK documents an empty
 * list as its isolation mode. Project instructions can still be supplied by a
 * future trusted prompt adapter; silently loading them here would be a weaker
 * boundary than the deployment policy promises.
 */
export function secureClaudeWebSdkOptions(
  options: ClaudeWebSdkOptions,
  security: ClaudeWebRuntimeSecurityOptions = {},
): void {
  if (security.readOnly === false) {
    return;
  }

  if (!options.env) {
    options.env = {};
  }
  delete options.env.CLAUDE_CODE_SIMPLE;

  if (typeof options.settings === 'string') {
    throw new Error('Claude Web runtime requires inline SDK settings.');
  }

  const settings = readSettingsRecord(options.settings);
  const existingPermissions = readSettingsRecord(settings.permissions);
  const existingEnvironment = filterClaudeSettingsEnvironment(settings.env);
  const existingDeniedTools = readSettingsStringList(existingPermissions.deny);
  const deniedTools = [...new Set([
    ...existingDeniedTools,
    ...CLAUDE_READ_ONLY_DENIED_TOOLS,
  ])];
  const readOnlyAdditionalDirectories = normalizeReadOnlyAdditionalDirectories(
    security.readOnlyAdditionalDirectories,
  );
  const hardenedSettings: Record<string, unknown> = {
    ...copySafeClaudeSettings(settings),
    // A settings-file hook/statusLine can spawn arbitrary commands.  Remove
    // both values from the inline layer; settingSources=[] below also prevents
    // project/user/local files from being loaded in the first place.
    env: {
      ...existingEnvironment,
      CLAUDE_CODE_SIMPLE: '',
    },
    permissions: {
      allow: [],
      ask: [],
      deny: deniedTools,
      defaultMode: 'plan',
      disableBypassPermissionsMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: readOnlyAdditionalDirectories,
    },
    disableAllHooks: true,
    disableAgentView: true,
    disableRemoteControl: true,
    disableWorkflows: true,
    enableWorkflows: false,
    disableSkillShellExecution: true,
    disableArtifact: true,
    enableArtifact: false,
    disableClaudeAiConnectors: true,
    disableCommandPluginSources: true,
    disableSideloadFlags: true,
    disableBundledSkills: true,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    enableAllProjectMcpServers: false,
    allowedMcpServers: [],
    enabledMcpjsonServers: [],
  };
  for (const key of [
    // These settings can spawn commands, load executable extension files, or
    // widen the filesystem/network scope if a newer Claude CLI consults them
    // before the SDK callback runs.
    'hooks',
    'statusLine',
    'sandbox',
    'worktree',
    'fileSuggestion',
    'processWrapper',
    'policyHelper',
    'policyHelpers',
    'awsCredentialExport',
    'awsAuthRefresh',
    'gcpAuthRefresh',
    'bashPath',
    'defaultShell',
    'respondToBashCommands',
    'promptSuggestions',
    'agentProgressSummaries',
    'pluginSuggestionMarketplaces',
    'additionalMarketplaces',
    // Inline settings can be supplied by the runtime bridge or a future
    // adapter.  Even though settingSources=[] blocks filesystem settings,
    // these object-valued fields are accepted directly by newer Claude CLI
    // versions and may carry commands, agents, plugin manifests, or MCP
    // definitions.  Keep the readonly contract explicit instead of relying
    // on the current SDK's undocumented precedence rules.
    'claudeMd',
    'commands',
    'skills',
    'plugins',
    'mcpServers',
    'mcp_servers',
    'agents',
    'agent',
  ]) {
    delete hardenedSettings[key];
  }
  options.settings = hardenedSettings;

  // `disableCommandPluginSources`, `disableSideloadFlags`, and several other
  // extension controls are documented as managed-settings-only in the Claude
  // SDK.  Supplying them solely in `--settings` would therefore be ignored by
  // newer CLIs.  Keep a policy-tier copy with the explicit managed locks, but
  // never inherit caller-controlled managed settings or credentials.
  options.managedSettings = buildReadOnlyManagedSettings(
    deniedTools,
    readOnlyAdditionalDirectories,
  );

  // Do not load user, project, or local settings in a product/QA child. The
  // SDK explicitly documents [] as its isolation mode; this prevents a
  // repository-controlled settings.json from registering hooks/plugins before
  // canUseTool gets a chance to deny their tools.
  options.settingSources = [];
  options.strictMcpConfig = true;
  options.tools = [...CLAUDE_READ_ONLY_TOOLS];
  // Keep the SDK's secondary permission-rule channel in lockstep with the
  // exact tool list. A caller can otherwise pass `allowedTools: ['Bash']`
  // while relying on `tools` alone; older Claude CLIs accepted that rule even
  // when a newer CLI treated the exact tools array as an additive hint.
  options.allowedTools = [...CLAUDE_READ_ONLY_TOOLS];
  options.disallowedTools = deniedTools;
  options.plugins = [];
  delete options.hooks;

  // These SDK options can add executable tools, launch subagents, or redirect
  // a built-in tool to an MCP/plugin implementation.  Delete them rather than
  // trusting every future caller to remember the deployment boundary.
  delete options.agents;
  delete options.agent;
  // Only the server-owned attachment root may be added.  Never preserve the
  // caller's SDK value, which could point at ~/.ssh, another checkout, or `/`.
  if (readOnlyAdditionalDirectories.length > 0) {
    options.additionalDirectories = readOnlyAdditionalDirectories;
  } else {
    delete options.additionalDirectories;
  }
  delete options.extraArgs;
  delete options.toolAliases;
  delete options.skills;
  delete options.sandbox;
  delete options.allowDangerouslySkipPermissions;
  options.permissionMode = 'plan';
  options.mcpServers = {};
}
