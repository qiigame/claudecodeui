import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapPermissionModeToCodexOptions,
  sanitizeCodexReadonlyConfig,
  stripCodexReadonlyConfigOverrides,
} from '@/modules/providers/list/codex/codex-runtime-options.provider.js';

test('workspace-write Codex modes enable outbound network access', () => {
  assert.deepEqual(mapPermissionModeToCodexOptions('default'), {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    webSearchMode: 'live',
  });
  assert.deepEqual(mapPermissionModeToCodexOptions('acceptEdits'), {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    webSearchMode: 'live',
  });
});

test('read-only Codex mode uses a kernel-enforced read-only sandbox', () => {
  assert.deepEqual(mapPermissionModeToCodexOptions('plan'), {
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  });
  assert.deepEqual(mapPermissionModeToCodexOptions('readonly'), {
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  });
});

test('unknown Codex permission modes fail closed', () => {
  for (const value of ['', 'unexpected', null, undefined, 42]) {
    assert.throws(
      () => mapPermissionModeToCodexOptions(value),
      /Unsupported Codex permission mode/,
    );
  }
});

test('bypass mode does not add a workspace-write network override', () => {
  assert.deepEqual(mapPermissionModeToCodexOptions('bypassPermissions'), {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    webSearchMode: 'live',
  });
});

test('readonly Codex config keeps API routing metadata but strips executable controls', () => {
  assert.deepEqual(sanitizeCodexReadonlyConfig({
    model_provider: 'dataverse',
    service_tier: 'fast',
    openai_base_url: 'https://api.example.test/v1',
    features: {
      unbounded_connection_retries: true,
      fast_mode: true,
      web_search: 'live',
    },
    model_providers: {
      dataverse: {
        name: 'Dataverse',
        base_url: 'https://api.example.test/v1',
        env_key: 'CUSTOM_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 2,
        stream_max_retries: 2,
        stream_idle_timeout_ms: 180_000,
        command: '/tmp/should-not-survive',
      },
      '__proto__': {
        name: 'prototype pollution',
        base_url: 'https://evil.example.test',
        env_key: 'EVIL_KEY',
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
    mcp_servers: {
      browser: { command: 'node', args: ['evil.js'] },
    },
    sandbox_workspace_write: { network_access: true },
    approval_policy: 'never',
    plugins: { enabled: true },
    notify: '/tmp/hook',
    shell_environment_policy: { inherit: 'all' },
  }), {
    model_provider: 'dataverse',
    service_tier: 'fast',
    openai_base_url: 'https://api.example.test/v1',
    features: {
      unbounded_connection_retries: false,
      plugins: false,
      remote_plugin: false,
      fast_mode: true,
    },
    model_providers: {
      dataverse: {
        name: 'Dataverse',
        base_url: 'https://api.example.test/v1',
        env_key: 'CUSTOM_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 2,
        stream_max_retries: 2,
        stream_idle_timeout_ms: 180_000,
      },
    },
    mcp_servers: {},
  });
});

test('readonly Codex drops every raw override, including whitespace and nested MCP/network keys', () => {
  assert.deepEqual(stripCodexReadonlyConfigOverrides([
    'mcp_servers.browser.command="node"',
    'mcp_servers = { browser = {} }',
    ' sandbox_workspace_write.network_access=true',
    'web_search="live"',
    'notify="/tmp/hook"',
    'model_provider="evil"',
  ]), []);
  assert.deepEqual(stripCodexReadonlyConfigOverrides('not-an-array'), []);
});
