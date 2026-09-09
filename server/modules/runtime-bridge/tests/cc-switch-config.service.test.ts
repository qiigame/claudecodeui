import assert from 'node:assert/strict';
import test from 'node:test';

import { createCcSwitchConfigService } from '@/modules/runtime-bridge/index.js';

test('reads the current Codex provider defaults from CC-Switch generated TOML', async () => {
  let pathname = '';
  const service = createCcSwitchConfigService({
    homeDirectory: () => '/Users/tester',
    readTextFile: async (requestedPath) => {
      pathname = requestedPath;
      return `
model = "gpt-5.6-sol"
model_provider = "dataverse"
model_reasoning_effort = "ultra"
service_tier = "fast"

[features]
fast_mode = true

[model_providers.dataverse]
name = "Dataverse"
base_url = "https://ai-agent.dataverse.cn/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
`;
    },
  });

  assert.deepEqual(await service.readCodexConfiguration({}), {
    model: 'gpt-5.6-sol',
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
  });
  assert.equal(pathname, '/Users/tester/.codex/config.toml');
});

test('reads the explicit CC-Switch Codex config path used by the UI MCP provider', async () => {
  let pathname = '';
  const service = createCcSwitchConfigService({
    homeDirectory: () => '/Users/tester',
    readTextFile: async (requestedPath) => {
      pathname = requestedPath;
      return 'model = "gpt-5.6-sol"';
    },
  });

  await service.readCodexConfiguration({
    COMIC_CC_SWITCH_CODEX_CONFIG_PATH: '/var/lib/cc-switch/codex.toml',
  });
  assert.equal(pathname, '/var/lib/cc-switch/codex.toml');
});

test('defaults the standard Codex env key when CC-Switch omits env_key', async () => {
  const service = createCcSwitchConfigService({
    readTextFile: async () => `
model_provider = "dataverse"

[model_providers.dataverse]
name = "Dataverse"
base_url = "https://ai-agent.dataverse.cn/v1"
wire_api = "responses"
requires_openai_auth = false
`,
  });

  const configuration = await service.readCodexConfiguration({});
  assert.equal(configuration?.modelProvider, 'dataverse');
  assert.deepEqual(configuration?.providerConfiguration, {
    name: 'Dataverse',
    baseUrl: 'https://ai-agent.dataverse.cn/v1',
    envKey: 'OPENAI_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
  });
});

test('omits incomplete Codex provider metadata instead of exposing partial fields', async () => {
  const service = createCcSwitchConfigService({
    readTextFile: async () => `
model_provider = "dataverse"

[model_providers.dataverse]
name = "Dataverse"
base_url = "https://ai-agent.dataverse.cn/v1"
requires_openai_auth = false
`,
  });

  const configuration = await service.readCodexConfiguration({});
  assert.equal(configuration?.modelProvider, 'dataverse');
  assert.equal(configuration?.providerConfiguration, undefined);
});

test('falls back to the standard env key for an invalid configured env_key', async () => {
  const service = createCcSwitchConfigService({
    readTextFile: async () => `
model_provider = "dataverse"

[model_providers.dataverse]
name = "Dataverse"
base_url = "https://ai-agent.dataverse.cn/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "BAD KEY"
`,
  });

  assert.equal(
    (await service.readCodexConfiguration({}))?.providerConfiguration?.envKey,
    'OPENAI_API_KEY',
  );
});

test('loads host-owned Codex MCP servers while moving literal credentials to runtime env', async () => {
  const service = createCcSwitchConfigService({
    homeDirectory: () => '/Users/tester',
    readTextFile: async () => `
model_provider = "dataverse"

[model_providers.dataverse]
name = "Dataverse"
base_url = "https://ai-agent.dataverse.cn/v1"
wire_api = "responses"
requires_openai_auth = false

[mcp_servers.te-mcp-analysis]
url = "https://admin-ss.gamehaus.com/mcp/analysis/http/analysis"
default_tools_approval_mode = "approve"
enabled_tools = ["list_projects", "list_entities"]

  [mcp_servers.te-mcp-analysis.env_http_headers]
  mcp-token = "TE_MCP_TOKEN"

[mcp_servers.literal-http]
url = "https://example.test/mcp"

  [mcp_servers.literal-http.http_headers]
  Authorization = "Bearer secret-value"

[mcp_servers.local-tool]
command = "node"
args = ["server.js"]
env = { API_KEY = "literal-secret" }

[mcp_servers.cloudcli-browser]
command = "${process.execPath}"
args = ["/opt/cloudcli/browser-use-mcp.js"]
env = { CLOUDCLI_BROWSER_USE_MCP_TOKEN = "browser-secret", CLOUDCLI_BROWSER_USE_API_URL = "http://127.0.0.1:3001/api/browser-use-mcp" }
`,
  });

  const configuration = await service.readCodexConfiguration({});
  const thinkingDataProxy = configuration?.mcpServers?.['te-mcp-analysis'];
  assert.equal(thinkingDataProxy?.command, process.execPath);
  assert.equal(
    (thinkingDataProxy?.args as string[])?.[0].endsWith(
      '/modules/providers/list/claude/thinkingdata-mcp-compat-proxy.js',
    ),
    true,
  );
  assert.deepEqual(thinkingDataProxy?.env, {
    CLOUDCLI_THINKINGDATA_MCP_URL: 'https://admin-ss.gamehaus.com/mcp/analysis/http/analysis',
    CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV: 'TE_MCP_TOKEN',
  });
  assert.deepEqual(thinkingDataProxy?.env_vars, [
    'TE_MCP_TOKEN',
    'TE_MCP_TOKEN_FILE',
    'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
  ]);
  assert.deepEqual(thinkingDataProxy?.enabled_tools, ['list_projects', 'list_entities']);
  assert.equal(thinkingDataProxy?.default_tools_approval_mode, 'approve');
  assert.deepEqual(configuration?.mcpServers && {
    'literal-http': {
      url: 'https://example.test/mcp',
      env_http_headers: {
        Authorization: 'CLOUDCLI_MCP_LITERAL_HTTP_AUTHORIZATION',
      },
    },
    'local-tool': {
      command: 'node',
      args: ['server.js'],
      env_vars: ['CLOUDCLI_MCP_LOCAL_TOOL_API_KEY'],
    },
  }, {
    'literal-http': configuration?.mcpServers?.['literal-http'],
    'local-tool': configuration?.mcpServers?.['local-tool'],
  });
  assert.deepEqual(configuration?.mcpEnvironment, {
    CLOUDCLI_MCP_LITERAL_HTTP_AUTHORIZATION: 'Bearer secret-value',
    CLOUDCLI_MCP_LOCAL_TOOL_API_KEY: 'literal-secret',
    CLOUDCLI_BROWSER_USE_MCP_TOKEN: 'browser-secret',
    CLOUDCLI_BROWSER_USE_API_URL: 'http://127.0.0.1:3001/api/browser-use-mcp',
  });
  assert.deepEqual(configuration?.mcpServers?.['cloudcli-browser'], {
    command: process.execPath,
    args: ['/opt/cloudcli/browser-use-mcp.js'],
    env_vars: ['CLOUDCLI_BROWSER_USE_MCP_TOKEN', 'CLOUDCLI_BROWSER_USE_API_URL'],
  });
});

test('ignores malformed or unsupported Codex MCP entries', async () => {
  const service = createCcSwitchConfigService({
    readTextFile: async () => `
[mcp_servers."bad.name"]
url = "https://example.test/mcp"

[mcp_servers.bad-scheme]
url = "file:///tmp/mcp"

[mcp_servers.valid]
url = "https://example.test/mcp"
`,
  });

  const configuration = await service.readCodexConfiguration({});
  assert.deepEqual(configuration?.mcpServers, {
    valid: { url: 'https://example.test/mcp' },
  });
});

test('reads Claude provider env and model compatibility settings without logging credentials', async () => {
  const service = createCcSwitchConfigService({
    homeDirectory: () => '/Users/tester',
    readTextFile: async () => JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://claude-provider.example',
        ANTHROPIC_API_KEY: 'secret-test-value',
        ANTHROPIC_MODEL: 'kimi-test',
        NON_STRING_VALUE: 42,
      },
      modelPicker: {
        options: [{ model: 'kimi-test', behavesAs: 'claude-sonnet-4-6' }],
      },
      theme: 'dark',
    }),
  });

  assert.deepEqual(await service.readClaudeConfiguration({}), {
    environment: {
      ANTHROPIC_BASE_URL: 'https://claude-provider.example',
      ANTHROPIC_API_KEY: 'secret-test-value',
      ANTHROPIC_MODEL: 'kimi-test',
    },
    model: 'kimi-test',
    settings: {
      modelPicker: {
        options: [{ model: 'kimi-test', behavesAs: 'claude-sonnet-4-6' }],
      },
    },
  });
});

test('returns null when generated provider files are unavailable or malformed', async () => {
  let malformed = false;
  const service = createCcSwitchConfigService({
    readTextFile: async () => {
      if (malformed) {
        return '{not-json';
      }
      throw new Error('missing');
    },
  });

  assert.equal(await service.readCodexConfiguration({}), null);
  malformed = true;
  assert.equal(await service.readClaudeConfiguration({}), null);
});
