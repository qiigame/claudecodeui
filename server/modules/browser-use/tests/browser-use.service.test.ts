import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrowserUseMcpRegistration,
  browserUseService,
  reconcileBrowserUseMcpRegistrationOnStartup,
} from '@/modules/browser-use/browser-use.service.js';

test('Browser MCP registration opts Codex into non-interactive trusted tool execution', () => {
  const registration = buildBrowserUseMcpRegistration({
    command: '/usr/local/bin/node',
    args: ['/app/browser-use-mcp.js'],
    token: 'test-browser-token',
    apiUrl: 'http://192.168.0.78:3090/api/browser-use-mcp',
  });

  assert.equal(registration.name, 'cloudcli-browser');
  assert.equal(registration.scope, 'user');
  assert.equal(registration.defaultToolsApprovalMode, 'approve');
  assert.equal(
    registration.env.CLOUDCLI_BROWSER_USE_API_URL,
    'http://192.168.0.78:3090/api/browser-use-mcp',
  );
});

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('startup reconciliation refreshes enabled Browser MCP registration', async () => {
  let registrations = 0;
  const registration = { name: 'cloudcli-browser', migrated: true };

  const result = await reconcileBrowserUseMcpRegistrationOnStartup({
    getSettings: async () => ({ enabled: true }),
    registerAgentMcp: async () => {
      registrations += 1;
      return registration;
    },
  });

  assert.equal(registrations, 1);
  assert.deepEqual(result, { enabled: true, registration });
});

test('startup reconciliation leaves disabled Browser MCP registration untouched', async () => {
  let registrations = 0;

  const result = await reconcileBrowserUseMcpRegistrationOnStartup({
    getSettings: async () => ({ enabled: false }),
    registerAgentMcp: async () => {
      registrations += 1;
      return { unexpected: true };
    },
  });

  assert.equal(registrations, 0);
  assert.deepEqual(result, { enabled: false, registration: null });
});
