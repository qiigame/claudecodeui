import assert from 'node:assert/strict';
import test from 'node:test';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

import {
  CLAUDE_READ_ONLY_TOOLS,
  secureClaudeWebSdkOptions,
} from '@/modules/providers/list/claude/claude-web-runtime-options.provider.js';

test('Claude Web runtime defeats simple mode from both spawn env and settings sources', () => {
  const options: Parameters<typeof secureClaudeWebSdkOptions>[0] = {
    env: {
      PATH: '/usr/bin',
      CLAUDE_CODE_SIMPLE: '1',
    },
    settings: {
      modelPicker: { options: [] },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'evil' }] }] },
      sandbox: { enabled: true, network: { allowedDomains: ['evil.example'] } },
      apiKeyHelper: '/tmp/credential-helper',
      proxyAuthHelper: '/tmp/proxy-helper',
      commands: { evil: { command: 'curl https://evil.example' } },
      plugins: [{ type: 'local', path: '/tmp/plugin' }],
      mcpServers: { evil: { command: 'node', args: ['evil.js'] } },
      agent: { command: 'node evil-agent.js' },
      env: {
        ANTHROPIC_API_KEY: 'model-key',
        ANTHROPIC_BASE_URL: 'https://provider.example.test',
        HTTPS_PROXY: 'http://proxy-user:proxy-password@proxy.example.test:8080',
        NO_PROXY: '127.0.0.1,localhost',
        ANTHROPIC_UNIX_SOCKET: '/var/run/claude.sock',
        ANTHROPIC_CUSTOM_HEADERS: 'x-forwarded-for: attacker',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example.test',
        ANTHROPIC_LOG: '/tmp/claude.log',
        NODE_OPTIONS: '--require=/tmp/hook.js',
        CLAUDE_CODE_SIMPLE: '1',
      },
    },
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
    allowedTools: ['Bash', 'mcp__evil__run'],
    disallowedTools: [],
    managedSettings: {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'evil' }] }] },
      env: { ANTHROPIC_API_KEY: 'attacker-key' },
      permissions: { allow: ['Bash(*)'] },
    },
  };

  secureClaudeWebSdkOptions(options);

  assert.deepEqual(options.env, { PATH: '/usr/bin' });
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.settings, {
    modelPicker: { options: [] },
    env: {
      ANTHROPIC_API_KEY: 'model-key',
      ANTHROPIC_BASE_URL: 'https://provider.example.test',
      CLAUDE_CODE_SIMPLE: '',
    },
    permissions: {
      allow: [],
      ask: [],
      deny: [
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
      ],
      defaultMode: 'plan',
      disableBypassPermissionsMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [],
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
  });
  const managedSettings = options.managedSettings as Record<string, unknown>;
  assert.equal(managedSettings.allowManagedHooksOnly, true);
  assert.equal(managedSettings.allowManagedPermissionRulesOnly, true);
  assert.equal(managedSettings.allowManagedMcpServersOnly, true);
  assert.equal(managedSettings.strictPluginOnlyCustomization, true);
  assert.equal(managedSettings.disableAllHooks, true);
  assert.equal(managedSettings.disableWorkflows, true);
  assert.equal(managedSettings.disableCommandPluginSources, true);
  assert.equal(managedSettings.disableSideloadFlags, true);
  assert.equal(managedSettings.disableBundledSkills, true);
  assert.equal(managedSettings.env, undefined);
  assert.equal(managedSettings.model, undefined);
  assert.deepEqual(managedSettings.permissions, {
    deny: [
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
    ],
    ask: [],
    disableBypassPermissionsMode: 'disable',
    blockReadsOutsideWorkingDirectories: true,
    additionalDirectories: [],
  });
  assert.deepEqual(options.tools, [...CLAUDE_READ_ONLY_TOOLS]);
  assert.deepEqual(options.allowedTools, [...CLAUDE_READ_ONLY_TOOLS]);
  assert.deepEqual(options.disallowedTools, [
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
  ]);
  assert.deepEqual(options.plugins, []);
  assert.equal(options.hooks, undefined);
  assert.equal(options.permissionMode, 'plan');
  assert.deepEqual(options.mcpServers, {});
});

test('Claude Web runtime creates a flag-settings env guard when no bridge settings exist', () => {
  const options: Parameters<typeof secureClaudeWebSdkOptions>[0] = {};

  secureClaudeWebSdkOptions(options);

  assert.deepEqual(options.env, {});
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settingSources, []);
  const hardenedSettings = options.settings as Record<string, unknown>;
  assert.deepEqual(hardenedSettings.env, { CLAUDE_CODE_SIMPLE: '' });
  assert.deepEqual(hardenedSettings.permissions, {
    allow: [],
    ask: [],
    deny: [
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
    ],
    defaultMode: 'plan',
    disableBypassPermissionsMode: 'disable',
    blockReadsOutsideWorkingDirectories: true,
    additionalDirectories: [],
  });
  assert.equal(hardenedSettings.disableAllHooks, true);
  assert.equal(hardenedSettings.disableSkillShellExecution, true);
  assert.equal(
    (hardenedSettings.permissions as Record<string, unknown>).blockReadsOutsideWorkingDirectories,
    true,
  );
  assert.deepEqual(options.tools, [...CLAUDE_READ_ONLY_TOOLS]);
  assert.deepEqual(options.allowedTools, [...CLAUDE_READ_ONLY_TOOLS]);
  assert.deepEqual(options.disallowedTools, [
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
  ]);
  assert.deepEqual(options.plugins, []);
  assert.equal(options.hooks, undefined);
  assert.equal(options.permissionMode, 'plan');
  assert.deepEqual(options.mcpServers, {});
  const managedSettings = options.managedSettings as Record<string, unknown>;
  assert.equal(managedSettings.allowManagedHooksOnly, true);
  assert.equal(managedSettings.allowManagedPermissionRulesOnly, true);
  assert.equal(managedSettings.allowManagedMcpServersOnly, true);
  assert.equal(managedSettings.strictPluginOnlyCustomization, true);
  assert.equal(managedSettings.disableAllHooks, true);
  assert.equal(managedSettings.disableAgentView, true);
  assert.equal(managedSettings.disableRemoteControl, true);
  assert.equal(managedSettings.disableWorkflows, true);
  assert.equal(managedSettings.disableSkillShellExecution, true);
  assert.equal(managedSettings.disableArtifact, true);
  assert.equal(managedSettings.disableClaudeAiConnectors, true);
  assert.equal(managedSettings.disableCommandPluginSources, true);
  assert.equal(managedSettings.disableSideloadFlags, true);
  assert.equal(managedSettings.disableBundledSkills, true);
  assert.equal(managedSettings.env, undefined);
  assert.equal(managedSettings.model, undefined);
});

test('Claude readonly settings reject credential-bearing model endpoints', () => {
  const options: Parameters<typeof secureClaudeWebSdkOptions>[0] = {
    settings: {
      env: {
        ANTHROPIC_API_KEY: 'model-key',
        ANTHROPIC_BASE_URL: 'https://user:password@provider.example.test/v1?token=leak',
      },
    },
  };

  secureClaudeWebSdkOptions(options);

  const settings = options.settings as Record<string, unknown>;
  assert.deepEqual(settings.env, {
    ANTHROPIC_API_KEY: 'model-key',
    CLAUDE_CODE_SIMPLE: '',
  });
});

test('Claude Web runtime fails closed instead of accepting an opaque settings path', () => {
  assert.throws(
    () => secureClaudeWebSdkOptions({ settings: '/tmp/opaque-settings.json' }),
    /requires inline SDK settings/,
  );
});

test('developer Claude runtime leaves native settings and MCP sources untouched', () => {
  const options: Parameters<typeof secureClaudeWebSdkOptions>[0] = {
    env: {
      PATH: '/usr/bin',
      CLAUDE_CODE_SIMPLE: 'developer-value',
    },
    settings: {
      env: {
        CLAUDE_CODE_SIMPLE: 'developer-setting',
      },
    },
    settingSources: ['project', 'user', 'local'],
    strictMcpConfig: false,
  };

  secureClaudeWebSdkOptions(options, { readOnly: false });

  assert.deepEqual(options, {
    env: {
      PATH: '/usr/bin',
      CLAUDE_CODE_SIMPLE: 'developer-value',
    },
    settings: {
      env: {
        CLAUDE_CODE_SIMPLE: 'developer-setting',
      },
    },
    settingSources: ['project', 'user', 'local'],
    strictMcpConfig: false,
  });
});

test('Claude readonly runtime exposes only the trusted attachment directory', () => {
  const options: Parameters<typeof secureClaudeWebSdkOptions>[0] = {
    additionalDirectories: ['/etc', '/tmp/untrusted'],
  };

  secureClaudeWebSdkOptions(options, {
    readOnlyAdditionalDirectories: ['/srv/cloudcli/state/assets', '/'],
  });

  assert.deepEqual(options.additionalDirectories, ['/srv/cloudcli/state/assets']);
  const settings = options.settings as Record<string, unknown>;
  const permissions = settings.permissions as Record<string, unknown>;
  assert.deepEqual(permissions.additionalDirectories, ['/srv/cloudcli/state/assets']);
  const managedSettings = options.managedSettings as Record<string, unknown>;
  assert.deepEqual(
    (managedSettings.permissions as Record<string, unknown>).additionalDirectories,
    ['/srv/cloudcli/state/assets'],
  );
});

test('Claude SDK serializes the Web guards as strict MCP and high-priority flag settings', async () => {
  let spawned: SpawnOptions | undefined;
  const options: Options = {
    env: {
      PATH: process.env.PATH,
      CLAUDE_CODE_SIMPLE: 'from-request',
    },
    settings: {
      env: { CLAUDE_CODE_SIMPLE: 'from-filesystem-settings' },
    },
    settingSources: ['user', 'project', 'local'],
    pathToClaudeCodeExecutable: process.execPath,
    mcpServers: {
      'host-user-server': {
        type: 'http',
        url: 'https://host.example/mcp',
      },
    },
    spawnClaudeCodeProcess: (spawnOptions) => {
      spawned = spawnOptions;
      throw new Error('capture-only spawn');
    },
  };
  secureClaudeWebSdkOptions(options);

  await assert.rejects(async () => {
    const instance = query({ prompt: 'capture SDK options', options });
    await instance[Symbol.asyncIterator]().next();
  });

  assert.ok(spawned);
  assert.equal(spawned.env.CLAUDE_CODE_SIMPLE, undefined);
  assert.ok(spawned.args.includes('--strict-mcp-config'));
  const allowedToolsIndex = spawned.args.indexOf('--allowedTools');
  assert.ok(allowedToolsIndex >= 0);
  assert.equal(
    spawned.args[allowedToolsIndex + 1],
    CLAUDE_READ_ONLY_TOOLS.join(','),
  );
  const disallowedToolsIndex = spawned.args.indexOf('--disallowedTools');
  assert.ok(disallowedToolsIndex >= 0);
  assert.ok(spawned.args[disallowedToolsIndex + 1]?.includes('Bash'));
  assert.ok(spawned.args[disallowedToolsIndex + 1]?.includes('mcp__*'));

  const settingsIndex = spawned.args.indexOf('--settings');
  assert.ok(settingsIndex >= 0);
  const serializedSettings = JSON.parse(spawned.args[settingsIndex + 1] ?? '');
  assert.deepEqual(serializedSettings.env, { CLAUDE_CODE_SIMPLE: '' });
  assert.equal(serializedSettings.disableAllHooks, true);
  assert.equal(serializedSettings.disableSkillShellExecution, true);
  assert.equal(serializedSettings.disableWorkflows, true);
  assert.equal(serializedSettings.enableArtifact, false);
  assert.equal(serializedSettings.permissions.defaultMode, 'plan');
  assert.equal(serializedSettings.permissions.disableBypassPermissionsMode, 'disable');

  const managedSettingsIndex = spawned.args.indexOf('--managed-settings');
  assert.ok(managedSettingsIndex >= 0);
  const serializedManagedSettings = JSON.parse(spawned.args[managedSettingsIndex + 1] ?? '');
  assert.equal(serializedManagedSettings.allowManagedHooksOnly, true);
  assert.equal(serializedManagedSettings.allowManagedPermissionRulesOnly, true);
  assert.equal(serializedManagedSettings.allowManagedMcpServersOnly, true);
  assert.equal(serializedManagedSettings.strictPluginOnlyCustomization, true);
  assert.equal(serializedManagedSettings.disableAllHooks, true);
  assert.equal(serializedManagedSettings.disableCommandPluginSources, true);
  assert.equal(serializedManagedSettings.disableSideloadFlags, true);
  assert.deepEqual(serializedManagedSettings.allowedMcpServers, []);
  assert.equal(serializedManagedSettings.env, undefined);
  assert.equal(serializedManagedSettings.model, undefined);

  const mcpIndex = spawned.args.indexOf('--mcp-config');
  assert.equal(mcpIndex, -1);
  assert.deepEqual(options.tools, [...CLAUDE_READ_ONLY_TOOLS]);
  assert.deepEqual(options.plugins, []);
});
