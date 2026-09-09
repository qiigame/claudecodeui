import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataverseRuntimeBridgeService } from '@/modules/runtime-bridge/index.js';

test('leaves both providers unchanged when the token helper is not configured', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({ OPENAI_API_KEY: 'existing-openai-value' }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'unused-test-value';
    },
  });

  assert.equal(await service.resolveCodexRuntime(), null);
  assert.equal(await service.resolveClaudeRuntime(), null);
  assert.equal(service.isConfigured(), false);
  assert.equal(executions, 0);
});

test('does not execute a Dataverse helper for a readonly turn unless explicitly allowed', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
    }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'must-not-be-read';
    },
  });

  assert.equal(service.isConfigured({ deploymentReadOnly: true }), false);
  assert.equal(await service.resolveCodexRuntime({ deploymentReadOnly: true }), null);
  assert.equal(await service.resolveClaudeRuntime({ deploymentReadOnly: true }), null);
  assert.equal(executions, 0);
});

test('readonly helper disablement does not route ambient provider keys to Dataverse', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      // The helper is present but the readonly deployment has not opted into
      // executing it. Ambient keys must not silently select the bridge's
      // default Dataverse endpoint in that case.
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
      OPENAI_API_KEY: 'ambient-openai-key',
      ANTHROPIC_API_KEY: 'ambient-anthropic-key',
    }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'must-not-be-read';
    },
  });

  assert.equal(await service.resolveCodexRuntime({ deploymentReadOnly: true }), null);
  assert.equal(await service.resolveClaudeRuntime({ deploymentReadOnly: true }), null);
  assert.equal(executions, 0);
});

test('allows a readonly Dataverse helper only with the deployment opt-in', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
      CLOUDCLI_READONLY_ALLOW_DATAVERSE_HELPER: '1',
    }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'readonly-helper-token';
    },
  });

  assert.equal(service.isConfigured({ deploymentReadOnly: true }), true);
  assert.equal(
    (await service.resolveCodexRuntime({ deploymentReadOnly: true }))?.clientOptions.apiKey,
    'readonly-helper-token',
  );
  assert.equal(
    (await service.resolveClaudeRuntime({ deploymentReadOnly: true }))?.env.ANTHROPIC_AUTH_TOKEN,
    'readonly-helper-token',
  );
  assert.equal(executions, 2);
});

test('rejects non-canonical readonly helper opt-ins', async () => {
  for (const value of ['true', 'yes', 'on', '0', ' 1 ']) {
    let executions = 0;
    const service = createDataverseRuntimeBridgeService({
      getEnvironment: () => ({
        COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
        CLOUDCLI_READONLY_ALLOW_DATAVERSE_HELPER: value,
      }),
      executeTokenHelper: async () => {
        executions += 1;
        return 'must-not-be-read';
      },
    });

    assert.equal(await service.resolveCodexRuntime({ deploymentReadOnly: true }), null, value);
    assert.equal(executions, 0, value);
  }
});

test('readonly bridge can use an explicit provider credential without executing a disabled helper', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
      COMIC_CODEX_BASE_URL: 'https://ai-agent.dataverse.cn/v1',
      COMIC_CLAUDE_BASE_URL: 'https://ai-agent.dataverse.cn',
      OPENAI_API_KEY: 'readonly-openai-token',
      ANTHROPIC_API_KEY: 'readonly-anthropic-token',
    }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'must-not-be-read';
    },
  });

  assert.equal(
    (await service.resolveCodexRuntime({ deploymentReadOnly: true }))?.clientOptions.apiKey,
    'readonly-openai-token',
  );
  assert.equal(
    (await service.resolveClaudeRuntime({ deploymentReadOnly: true }))?.env.ANTHROPIC_AUTH_TOKEN,
    'readonly-anthropic-token',
  );
  assert.equal(executions, 0);
});

test('runtime bridge keeps the readonly posture captured at startup', async () => {
  let executions = 0;
  const environment: NodeJS.ProcessEnv = {
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
  };
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => environment,
    executeTokenHelper: async () => {
      executions += 1;
      return 'must-not-be-read-after-profile-mutation';
    },
  });

  // A later process.env/config mutation cannot reopen a bridge that was
  // constructed under the managed readonly profile. The per-call option is
  // intentionally false here to exercise the startup floor.
  environment.CLOUDCLI_DEPLOYMENT_PROFILE = 'developer';
  assert.equal(await service.resolveCodexRuntime({ deploymentReadOnly: false }), null);
  assert.equal(executions, 0);
});

test('readonly helper opt-in is captured at startup and cannot be enabled mid-process', async () => {
  let executions = 0;
  const environment: NodeJS.ProcessEnv = {
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
  };
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => environment,
    executeTokenHelper: async () => {
      executions += 1;
      return 'must-not-be-read-after-opt-in-mutation';
    },
  });

  environment.CLOUDCLI_READONLY_ALLOW_DATAVERSE_HELPER = '1';
  assert.equal(service.isConfigured({ deploymentReadOnly: false }), false);
  assert.equal(await service.resolveClaudeRuntime({ deploymentReadOnly: false }), null);
  assert.equal(executions, 0);
});

test('explicit developer plus DingTalk remains writable for local SSO development', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
      CLOUDCLI_REQUIRE_DINGTALK_AUTH: 'true',
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
    }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'developer-helper-token';
    },
  });

  assert.equal(
    (await service.resolveCodexRuntime({ deploymentReadOnly: false }))?.clientOptions.apiKey,
    'developer-helper-token',
  );
  assert.equal(executions, 1);
});

test('a developer-named profile with all mutating capabilities removed is readonly', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
      CLOUDCLI_DEPLOYMENT_CAPABILITIES: [
        'repo.write=false',
        'project.mutate=false',
        'file.write=false',
        'worktree.mutate=false',
        'git.fetch=false',
        'git.write=false',
        'shell.exec=false',
        'terminal.interactive=false',
        'agent.use=false',
        'provider.write=false',
        'mcp.write=false',
        'plugin.use=false',
        'plugin.write=false',
        'browser.use=false',
        'settings.write=false',
        'local-filesystem=false',
        'local-git=false',
        'local-shell=false',
      ].join(','),
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
    }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'must-not-be-read';
    },
  });

  assert.equal(await service.resolveCodexRuntime({ deploymentReadOnly: false }), null);
  assert.equal(executions, 0);
});

test('implicit DingTalk deployment stays readonly even when the per-call flag is omitted', async () => {
  let executions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      CLOUDCLI_DINGTALK_PUBLIC_ORIGIN: 'https://cloudcli.example.test',
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/dataverse-token-helper',
    }),
    executeTokenHelper: async () => {
      executions += 1;
      return 'must-not-be-read';
    },
  });

  assert.equal(await service.resolveClaudeRuntime({ deploymentReadOnly: false }), null);
  assert.equal(executions, 0);
});

test('maps an explicitly configured Codex CODEX_API_KEY into the provider env without a helper', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CODEX_BASE_URL: 'https://ai-agent.dataverse.cn/v1',
      COMIC_CODEX_MODEL: 'kimi-k2.6',
      CODEX_API_KEY: 'direct-codex-test-value',
    }),
    executeTokenHelper: async () => {
      throw new Error('the helper must not be called in direct mode');
    },
  });

  const bridge = await service.resolveCodexRuntime();

  assert.equal(service.isConfigured(), true);
  assert.equal(bridge?.clientOptions.apiKey, 'direct-codex-test-value');
  assert.equal(bridge?.clientOptions.env.CODEX_API_KEY, 'direct-codex-test-value');
  // Dataverse's provider declaration explicitly requires OPENAI_API_KEY;
  // copying the Codex-specific key here is what makes Web SDK turns and PTY
  // turns authenticate consistently.
  assert.equal(bridge?.clientOptions.env.OPENAI_API_KEY, 'direct-codex-test-value');
  assert.equal(bridge?.clientOptions.config.model_provider, 'dataverse');
  assert.equal(
    bridge?.clientOptions.config.model_providers?.dataverse.base_url,
    'https://ai-agent.dataverse.cn/v1',
  );
});

test('builds exact Codex provider overrides and executes the helper without a shell', async () => {
  const calls: Array<{ path: string; args: string[]; options: Record<string, unknown> }> = [];
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
      COMIC_CODEX_BASE_URL: 'http://127.0.0.1:4000/v1',
      COMIC_CODEX_MODEL: 'gpt-test-model',
      COMIC_CODEX_REASONING_EFFORT: 'low',
      COMIC_CODEX_CLI_PATH: '/opt/comic/codex',
      PATH: '/usr/bin',
      OMITTED_VALUE: undefined,
    }),
    executeTokenHelper: async (path, args, options) => {
      calls.push({ path, args, options: { ...options } });
      return '  test-helper-value\n';
    },
  });

  const bridge = await service.resolveCodexRuntime();

  assert.deepEqual(calls, [{
    path: '/opt/comic/read-token',
    args: [],
    options: {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      shell: false,
    },
  }]);
  assert.deepEqual(bridge, {
    clientOptions: {
      apiKey: 'test-helper-value',
      env: {
        COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
        COMIC_CODEX_BASE_URL: 'http://127.0.0.1:4000/v1',
        COMIC_CODEX_MODEL: 'gpt-test-model',
        COMIC_CODEX_REASONING_EFFORT: 'low',
        COMIC_CODEX_CLI_PATH: '/opt/comic/codex',
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'test-helper-value',
      },
      codexPathOverride: '/opt/comic/codex',
      config: {
        model_provider: 'dataverse',
        features: {
          unbounded_connection_retries: false,
          plugins: false,
          remote_plugin: false,
        },
        model_providers: {
          dataverse: {
            name: 'Dataverse',
            base_url: 'http://127.0.0.1:4000/v1',
            env_key: 'OPENAI_API_KEY',
            wire_api: 'responses',
            requires_openai_auth: true,
            request_max_retries: 2,
            stream_max_retries: 2,
            stream_idle_timeout_ms: 180_000,
          },
        },
      },
    },
    model: 'gpt-test-model',
    reasoningEffort: 'low',
  });
});

test('keeps an isolated Codex HOME for the runtime while pointing the helper at the CC-Switch credential home', async () => {
  let helperEnvironment: NodeJS.ProcessEnv | undefined;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: '1',
      COMIC_CC_SWITCH_CODEX_CONFIG_PATH: '/srv/operator/.codex/config.toml',
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/bin/codex-dataverse-token',
      CODEX_HOME: '/srv/cloudcli/candidate/codex-home',
      HOME: '/srv/cloudcli/candidate/home',
    }),
    executeTokenHelper: async (_path, _args, options) => {
      helperEnvironment = options.env;
      return 'helper-token';
    },
    readCcSwitchCodexConfiguration: async () => ({
      model: 'kimi-k2.6',
      modelProvider: 'dataverse',
      providerConfiguration: {
        name: 'Dataverse',
        baseUrl: 'https://ai-agent.dataverse.cn/v1',
        envKey: 'OPENAI_API_KEY',
        wireApi: 'responses',
        requiresOpenaiAuth: true,
      },
    }),
  });

  const bridge = await service.resolveCodexRuntime();

  assert.equal(helperEnvironment?.CODEX_HOME, '/srv/operator/.codex');
  assert.equal(helperEnvironment?.HOME, '/srv/cloudcli/candidate/home');
  assert.equal(bridge?.clientOptions.env.CODEX_HOME, '/srv/cloudcli/candidate/codex-home');
  assert.equal(bridge?.clientOptions.env.OPENAI_API_KEY, 'helper-token');
});

test('honors an explicit helper Codex HOME over the inferred CC-Switch path', async () => {
  let helperEnvironment: NodeJS.ProcessEnv | undefined;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/bin/codex-dataverse-token',
      COMIC_DATAVERSE_TOKEN_HELPER_CODEX_HOME: '/srv/operator/credential-source',
      COMIC_CC_SWITCH_CODEX_CONFIG_PATH: '/srv/other/.codex/config.toml',
      CODEX_HOME: '/srv/cloudcli/candidate/codex-home',
    }),
    executeTokenHelper: async (_path, _args, options) => {
      helperEnvironment = options.env;
      return 'helper-token';
    },
  });

  await service.resolveCodexRuntime();

  assert.equal(
    helperEnvironment?.CODEX_HOME,
    '/srv/operator/credential-source',
  );
});

test('keeps an isolated Claude HOME while allowing a DSH helper to read its protected host credentials', async () => {
  let helperEnvironment: NodeJS.ProcessEnv | undefined;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: 'true',
      COMIC_CC_SWITCH_CLAUDE_SETTINGS_PATH: '/srv/operator/.claude/settings.json',
      COMIC_DATAVERSE_TOKEN_HELPER: '/srv/operator/bin/dsh-dataverse-token',
      HOME: '/srv/cloudcli/candidate/home',
      CLAUDE_CONFIG_DIR: '/srv/cloudcli/candidate/claude-config',
    }),
    executeTokenHelper: async (_path, _args, options) => {
      helperEnvironment = options.env;
      return 'helper-token';
    },
    readCcSwitchClaudeConfiguration: async () => ({
      environment: {
        ANTHROPIC_BASE_URL: 'https://ai-agent.dataverse.cn',
      },
      model: 'kimi-k2.6',
      settings: {},
    }),
  });

  const bridge = await service.resolveClaudeRuntime();

  assert.equal(helperEnvironment?.HOME, '/srv/operator');
  assert.equal(bridge?.env.HOME, '/srv/cloudcli/candidate/home');
  assert.equal(bridge?.env.ANTHROPIC_AUTH_TOKEN, 'helper-token');
});

test('runs the helper on every resolution and falls back to the Codex process environment', async () => {
  let executions = 0;
  const environment: NodeJS.ProcessEnv = {
    COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
    OPENAI_API_KEY: 'fallback-openai-value',
  };
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => environment,
    executeTokenHelper: async () => {
      executions += 1;
      if (executions === 1) {
        throw new Error('helper stderr must not escape');
      }
      return 'second-turn-value';
    },
  });

  const firstTurn = await service.resolveCodexRuntime();
  const secondTurn = await service.resolveCodexRuntime();

  assert.equal(executions, 2);
  assert.equal(firstTurn?.clientOptions.apiKey, 'fallback-openai-value');
  assert.equal(secondTurn?.clientOptions.apiKey, 'second-turn-value');
  assert.equal(
    firstTurn?.clientOptions.config.model_providers?.dataverse.base_url,
    'https://ai-agent.dataverse.cn/v1',
  );
});

test('injects Claude base URL, both auth variables, fixed model aliases, and config directory', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
      COMIC_CLAUDE_MODEL: 'kimi-test-model',
      COMIC_CLAUDE_CONFIG_DIR: '/var/lib/comic/claude',
      PATH: '/usr/bin',
    }),
    executeTokenHelper: async () => 'test-claude-value',
  });

  const bridge = await service.resolveClaudeRuntime();

  assert.equal(bridge?.model, 'kimi-test-model');
  assert.deepEqual(bridge?.env, {
    COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
    COMIC_CLAUDE_MODEL: 'kimi-test-model',
    COMIC_CLAUDE_CONFIG_DIR: '/var/lib/comic/claude',
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'https://ai-agent.dataverse.cn',
    ANTHROPIC_AUTH_TOKEN: 'test-claude-value',
    ANTHROPIC_API_KEY: 'test-claude-value',
    CLAUDE_CONFIG_DIR: '/var/lib/comic/claude',
    ANTHROPIC_MODEL: 'kimi-test-model',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-test-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-test-model',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-test-model',
  });
});

test('uses Claude environment fallback and keeps helper failures out of thrown errors', async () => {
  const fallbackService = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
      ANTHROPIC_AUTH_TOKEN: 'fallback-claude-value',
    }),
    executeTokenHelper: async () => {
      throw new Error('helper stderr contained token-test-marker');
    },
  });
  const unavailableService = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
    }),
    executeTokenHelper: async () => {
      throw new Error('helper stderr contained token-test-marker');
    },
  });

  assert.equal(
    (await fallbackService.resolveClaudeRuntime())?.env.ANTHROPIC_AUTH_TOKEN,
    'fallback-claude-value',
  );
  await assert.rejects(
    unavailableService.resolveClaudeRuntime(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Dataverse runtime credentials are unavailable.');
      assert.doesNotMatch(error.message, /token-test-marker|helper stderr/);
      return true;
    },
  );
});

test('ignores unsupported Codex reasoning effort instead of forwarding an invalid CLI value', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
      COMIC_CODEX_REASONING_EFFORT: 'fastest',
    }),
    executeTokenHelper: async () => 'test-helper-value',
  });

  const bridge = await service.resolveCodexRuntime();
  assert.equal(bridge?.reasoningEffort, undefined);
});

test('accepts the full Codex catalog reasoning range for server-controlled runtimes', async () => {
  let effort = 'max';
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
      COMIC_CODEX_REASONING_EFFORT: effort,
    }),
    executeTokenHelper: async () => 'test-helper-value',
  });

  assert.equal((await service.resolveCodexRuntime())?.reasoningEffort, 'max');
  effort = 'ultra';
  assert.equal((await service.resolveCodexRuntime())?.reasoningEffort, 'ultra');
});

test('loads the current CC-Switch Codex defaults for every new turn', async () => {
  let reads = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: '1',
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
      COMIC_CODEX_CLI_PATH: '/opt/comic/codex',
    }),
    executeTokenHelper: async () => 'switch-token',
    readCcSwitchCodexConfiguration: async () => {
      reads += 1;
      return {
        model: reads === 1 ? 'gpt-5.6-sol' : 'gpt-5.6-terra',
        reasoningEffort: 'ultra',
        serviceTier: 'fast',
        modelProvider: 'dataverse',
        providerConfiguration: {
          name: 'Dataverse',
          baseUrl: 'https://ai-agent.dataverse.cn/v1',
          envKey: 'OPENAI_API_KEY',
          wireApi: 'responses',
          requiresOpenaiAuth: false,
        },
        fastMode: true,
      };
    },
  });

  const first = await service.resolveCodexRuntime();
  const second = await service.resolveCodexRuntime();

  assert.equal(reads, 2);
  assert.equal(first?.model, 'gpt-5.6-sol');
  assert.equal(second?.model, 'gpt-5.6-terra');
  assert.equal(first?.reasoningEffort, 'ultra');
  assert.equal(first?.clientOptions.config.service_tier, 'fast');
  assert.equal(first?.clientOptions.config.model_provider, 'dataverse');
  assert.equal(first?.clientOptions.env.OPENAI_API_KEY, 'switch-token');
  assert.equal(
    first?.clientOptions.config.features.fast_mode,
    true,
  );
  assert.equal(
    first?.clientOptions.config.features.plugins,
    false,
  );
  assert.equal(
    first?.clientOptions.config.features.remote_plugin,
    false,
  );
  assert.deepEqual(first?.clientOptions.config.model_providers?.dataverse, {
    name: 'Dataverse',
    base_url: 'https://ai-agent.dataverse.cn/v1',
    env_key: 'OPENAI_API_KEY',
    wire_api: 'responses',
    requires_openai_auth: true,
    request_max_retries: 2,
    stream_max_retries: 2,
    stream_idle_timeout_ms: 180_000,
  });
});

test('uses a direct CODEX_API_KEY when CC-Switch sync is explicitly enabled without a helper', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: '1',
      CODEX_API_KEY: 'switch-direct-test-value',
    }),
    executeTokenHelper: async () => {
      throw new Error('the helper must not be called in direct CC-Switch mode');
    },
    readCcSwitchCodexConfiguration: async () => ({
      model: 'kimi-k2.6',
      modelProvider: 'dataverse',
      providerConfiguration: {
        name: 'Dataverse',
        baseUrl: 'https://ai-agent.dataverse.cn/v1',
        envKey: 'OPENAI_API_KEY',
        wireApi: 'responses',
        requiresOpenaiAuth: true,
      },
    }),
  });

  const bridge = await service.resolveCodexRuntime();

  assert.equal(bridge?.clientOptions.apiKey, 'switch-direct-test-value');
  assert.equal(bridge?.clientOptions.env.OPENAI_API_KEY, 'switch-direct-test-value');
  assert.equal(bridge?.clientOptions.env.CODEX_API_KEY, 'switch-direct-test-value');
});

test('uses a CC-Switch provider-specific credential env key when no helper is installed', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: '1',
      DATAVERSE_API_TOKEN: 'provider-specific-test-value',
    }),
    executeTokenHelper: async () => {
      throw new Error('the helper must not be called when it is not configured');
    },
    readCcSwitchCodexConfiguration: async () => ({
      model: 'kimi-k2.6',
      modelProvider: 'dataverse',
      providerConfiguration: {
        name: 'Dataverse',
        baseUrl: 'https://ai-agent.dataverse.cn/v1',
        envKey: 'DATAVERSE_API_TOKEN',
        wireApi: 'responses',
        requiresOpenaiAuth: true,
      },
    }),
  });

  const bridge = await service.resolveCodexRuntime();
  assert.equal(bridge?.clientOptions.apiKey, 'provider-specific-test-value');
  assert.equal(bridge?.clientOptions.env.DATAVERSE_API_TOKEN, 'provider-specific-test-value');
  assert.equal(bridge?.clientOptions.env.OPENAI_API_KEY, 'provider-specific-test-value');
});

test('passes sanitized CC-Switch MCP definitions and their env-backed values to Codex', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: '1',
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
    }),
    executeTokenHelper: async () => 'switch-token',
    readCcSwitchCodexConfiguration: async () => ({
      modelProvider: 'dataverse',
      providerConfiguration: {
        name: 'Dataverse',
        baseUrl: 'https://ai-agent.dataverse.cn/v1',
        envKey: 'OPENAI_API_KEY',
        wireApi: 'responses',
        requiresOpenaiAuth: false,
      },
      mcpServers: {
        'te-mcp-analysis': {
          url: 'https://admin-ss.gamehaus.com/mcp/analysis/http/analysis',
          env_http_headers: { 'mcp-token': 'TE_MCP_TOKEN' },
        },
      },
      mcpEnvironment: {
        CLOUDCLI_MCP_BROWSER_TOKEN: 'literal-value',
      },
    }),
  });

  const bridge = await service.resolveCodexRuntime();
  assert.deepEqual(bridge?.clientOptions.config.mcp_servers, {});
  const mcpOverride = bridge?.clientOptions.configOverrides?.[0] ?? '';
  assert.match(mcpOverride, /^mcp_servers=\{/);
  assert.match(mcpOverride, /command =/);
  assert.match(mcpOverride, /CLOUDCLI_THINKINGDATA_MCP_URL/);
  assert.doesNotMatch(mcpOverride, /url =/);
  assert.equal(bridge?.clientOptions.env.CLOUDCLI_MCP_BROWSER_TOKEN, 'literal-value');
  assert.equal(bridge?.clientOptions.env.OPENAI_API_KEY, 'switch-token');
  assert.equal(bridge?.mcpServers?.['te-mcp-analysis']?.command, process.execPath);
  assert.equal(bridge?.mcpServers?.['te-mcp-analysis']?.url, undefined);
});

test('fails closed when CC-Switch selects a provider without complete metadata', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: '1',
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
    }),
    executeTokenHelper: async () => 'switch-token',
    readCcSwitchCodexConfiguration: async () => ({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      serviceTier: 'fast',
      modelProvider: 'dataverse',
      fastMode: true,
    }),
  });

  await assert.rejects(
    service.resolveCodexRuntime(),
    (error: unknown) => error instanceof Error
      && error.message === 'CC-Switch Codex provider configuration is incomplete.',
  );
});

test('injects a CC-Switch provider-specific env key alongside the OpenAI default', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: '1',
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
    }),
    executeTokenHelper: async () => 'switch-token',
    readCcSwitchCodexConfiguration: async () => ({
      model: 'gpt-test',
      modelProvider: 'custom-provider',
      providerConfiguration: {
        name: 'Custom Provider',
        baseUrl: 'https://provider.example/v1',
        envKey: 'CUSTOM_API_KEY',
        wireApi: 'responses',
        requiresOpenaiAuth: false,
      },
      fastMode: false,
    }),
  });

  const bridge = await service.resolveCodexRuntime();
  assert.equal(bridge?.clientOptions.env.OPENAI_API_KEY, 'switch-token');
  assert.equal(bridge?.clientOptions.env.CUSTOM_API_KEY, 'switch-token');
  assert.deepEqual(bridge?.clientOptions.config.model_providers?.['custom-provider'], {
    name: 'Custom Provider',
    base_url: 'https://provider.example/v1',
    env_key: 'CUSTOM_API_KEY',
    wire_api: 'responses',
    requires_openai_auth: false,
    request_max_retries: 2,
    stream_max_retries: 2,
    stream_idle_timeout_ms: 180_000,
  });
});

test('loads Claude provider settings from CC-Switch but refreshes credentials through the token helper', async () => {
  let tokenHelperExecutions = 0;
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: 'true',
      COMIC_DATAVERSE_TOKEN_HELPER: '/opt/comic/read-token',
      COMIC_CLAUDE_CONFIG_DIR: '/var/lib/comic/claude',
    }),
    executeTokenHelper: async () => {
      tokenHelperExecutions += 1;
      return 'fresh-claude-token';
    },
    readCcSwitchClaudeConfiguration: async () => ({
      environment: {
        ANTHROPIC_BASE_URL: 'https://claude-provider.example',
        ANTHROPIC_API_KEY: 'claude-switch-token',
        ANTHROPIC_MODEL: 'claude-switch-model',
        CLAUDE_CODE_SIMPLE: '1',
      },
      model: 'claude-switch-model',
      settings: {
        modelPicker: { options: [] },
      },
    }),
  });

  const bridge = await service.resolveClaudeRuntime({ omitSimpleMode: true });

  assert.equal(tokenHelperExecutions, 1);
  assert.equal(bridge?.model, 'claude-switch-model');
  assert.equal(bridge?.env.ANTHROPIC_API_KEY, 'fresh-claude-token');
  assert.equal(bridge?.env.ANTHROPIC_AUTH_TOKEN, 'fresh-claude-token');
  assert.equal(bridge?.env.ANTHROPIC_BASE_URL, 'https://claude-provider.example');
  assert.equal(bridge?.env.CLAUDE_CONFIG_DIR, '/var/lib/comic/claude');
  assert.equal(bridge?.env.CLAUDE_CODE_SIMPLE, undefined);
  assert.deepEqual(bridge?.settings, { modelPicker: { options: [] } });
});

test('preserves Claude simple mode for non-chat consumers unless explicitly omitted', async () => {
  const service = createDataverseRuntimeBridgeService({
    getEnvironment: () => ({
      COMIC_CC_SWITCH_SYNC: 'true',
      CLAUDE_CODE_SIMPLE: 'host-value',
    }),
    readCcSwitchClaudeConfiguration: async () => ({
      environment: {
        ANTHROPIC_API_KEY: 'claude-switch-token',
        CLAUDE_CODE_SIMPLE: 'switch-value',
      },
      model: undefined,
      settings: {},
    }),
  });

  assert.equal(
    (await service.resolveClaudeRuntime())?.env.CLAUDE_CODE_SIMPLE,
    'switch-value',
  );
  assert.equal(
    (await service.resolveClaudeRuntime({ omitSimpleMode: true }))?.env.CLAUDE_CODE_SIMPLE,
    undefined,
  );
});
