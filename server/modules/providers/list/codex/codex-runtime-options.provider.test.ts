import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeCodexReadonlyClientOptions,
} from './codex-runtime-options.provider.js';

test('readonly Codex client options disable curated plugin sync while keeping model credentials', () => {
  const options = sanitizeCodexReadonlyClientOptions({
    apiKey: 'model-secret',
    baseUrl: 'https://provider.example.test/v1',
    codexPathOverride: '/tmp/operator-controlled-codex',
    env: {
      OPENAI_API_KEY: 'model-secret',
      CUSTOM_API_KEY: 'custom-secret',
    },
    config: {
      model_provider: 'provider',
      model_providers: {
        provider: {
          name: 'Provider',
          base_url: 'https://provider.example.test/v1',
          env_key: 'CUSTOM_API_KEY',
          wire_api: 'responses',
          requires_openai_auth: true,
        },
      },
      mcp_servers: {
        unsafe: { command: '/tmp/operator-controlled-mcp' },
      },
      features: {
        fast_mode: true,
        plugins: true,
        remote_plugin: true,
      },
    },
    configOverrides: ['mcp_servers.unsafe.command="/tmp/operator-controlled-mcp"'],
  });

  assert.equal(options.apiKey, 'model-secret');
  assert.equal(options.baseUrl, 'https://provider.example.test/v1');
  assert.deepEqual(options.env, {
    OPENAI_API_KEY: 'model-secret',
    CUSTOM_API_KEY: 'custom-secret',
  });
  assert.equal('codexPathOverride' in options, false);
  assert.deepEqual(options.configOverrides, []);
  assert.equal((options.config as Record<string, unknown>).model_provider, 'provider');
  assert.deepEqual(
    (options.config as Record<string, unknown>).features,
    {
      unbounded_connection_retries: false,
      fast_mode: true,
      plugins: false,
      remote_plugin: false,
    },
  );
  assert.deepEqual(
    (options.config as Record<string, unknown>).mcp_servers,
    {},
  );
});
