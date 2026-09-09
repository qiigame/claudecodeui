import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import {
  createBrowserUseMcpRouter,
  createBrowserUseMcpTokenGuard,
  mountBrowserUseMcpBridgeBeforeApiKey,
} from '../browser-use-mcp.routes.js';
import type { BrowserUseMcpService } from '../browser-use-mcp.routes.js';
import {
  createDeploymentPolicyMiddleware,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';

const BROWSER_TOKEN = 'browser-only-secret';
const INSTALLATION_API_KEY = 'installation-secret';

const installationApiKeyGuard: RequestHandler = (req, res, next) => {
  if (req.headers['x-api-key'] !== INSTALLATION_API_KEY) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
};

async function withProtectedBridge(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  const bridge = express.Router();
  bridge.use(createBrowserUseMcpTokenGuard({ getMcpToken: () => BROWSER_TOKEN }));
  bridge.post('/tools/browser_list_sessions', (_req, res) => {
    res.json({ success: true, data: [] });
  });

  mountBrowserUseMcpBridgeBeforeApiKey(app, installationApiKeyGuard, bridge);
  app.get('/api/ordinary', (_req, res) => {
    res.json({ success: true });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('Browser MCP bridge uses its dedicated token without requiring API_KEY', async () => {
  await withProtectedBridge(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use-mcp/tools/browser_list_sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${BROWSER_TOKEN}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: [] });
  });
});

test('API_KEY cannot bypass an invalid Browser MCP token', async () => {
  await withProtectedBridge(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use-mcp/tools/browser_list_sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-browser-token',
        'x-api-key': INSTALLATION_API_KEY,
      },
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'Invalid Browser MCP token.',
    });
  });
});

test('Browser MCP rejects ambiguous Authorization and custom-token credentials', async () => {
  await withProtectedBridge(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use-mcp/tools/browser_list_sessions`, {
      method: 'POST',
      headers: {
        authorization: 'Basic malformed-credential',
        'x-browser-use-mcp-token': BROWSER_TOKEN,
      },
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'Invalid Browser MCP token.',
    });
  });
});

test('Browser MCP rejects malformed and duplicated custom-token headers', async () => {
  const malformedRequests: Array<Record<string, string>> = [
    { 'x-browser-use-mcp-token': `${BROWSER_TOKEN} extra` },
    { 'x-browser-use-mcp-token': `${BROWSER_TOKEN},${BROWSER_TOKEN}` },
  ];

  await withProtectedBridge(async (baseUrl) => {
    for (const headers of malformedRequests) {
      const response = await fetch(`${baseUrl}/api/browser-use-mcp/tools/browser_list_sessions`, {
        method: 'POST',
        headers,
      });
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.deepEqual(await response.json(), {
        success: false,
        error: 'Invalid Browser MCP token.',
      });
    }
  });
});

test('ordinary API routes remain behind the installation API key', async () => {
  await withProtectedBridge(async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/ordinary`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/api/ordinary`, {
      headers: { 'x-api-key': INSTALLATION_API_KEY },
    });
    assert.equal(allowed.status, 200);
  });
});

test('Browser MCP parses tool bodies before applying read-only capability checks', async () => {
  const policy = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' });
  let tabCalls = 0;
  const service = {
    agentTabs: async () => {
      tabCalls += 1;
      return { unexpected: true };
    },
  } as unknown as BrowserUseMcpService;
  const app = express();
  app.use('/api/browser-use-mcp', createBrowserUseMcpRouter({
    tokenSource: { getMcpToken: () => BROWSER_TOKEN },
    service,
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const typed = error as { statusCode?: number; code?: string };
    response.status(typed.statusCode ?? 500).json({ code: typed.code });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/browser-use-mcp/tools/browser_tabs`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${BROWSER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'new', sessionId: 'session-1' }),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  assert.equal(tabCalls, 0);
});

test('Browser MCP read tools remain available in read-only mode', async () => {
  const policy = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' });
  let listCalls = 0;
  const service = {
    listAgentSessions: async () => {
      listCalls += 1;
      return [];
    },
  } as unknown as BrowserUseMcpService;
  const app = express();
  app.use('/api/browser-use-mcp', createBrowserUseMcpRouter({
    tokenSource: { getMcpToken: () => BROWSER_TOKEN },
    service,
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/browser-use-mcp/tools/browser_list_sessions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${BROWSER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: [] });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  assert.equal(listCalls, 1);
});

test('Browser MCP treats selecting a tab as a mutation in read-only mode', async () => {
  const policy = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' });
  let tabCalls = 0;
  const service = {
    agentTabs: async () => {
      tabCalls += 1;
      return { unexpected: true };
    },
  } as unknown as BrowserUseMcpService;
  const app = express();
  app.use('/api/browser-use-mcp', createBrowserUseMcpRouter({
    tokenSource: { getMcpToken: () => BROWSER_TOKEN },
    service,
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const typed = error as { statusCode?: number; code?: string };
    response.status(typed.statusCode ?? 500).json({ code: typed.code });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/browser-use-mcp/tools/browser_tabs`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${BROWSER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'select', sessionId: 'session-1', index: 1 }),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  assert.equal(tabCalls, 0);
});

test('standalone Browser MCP captures its deployment policy once', async () => {
  const policy = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' });
  let captures = 0;
  let tabCalls = 0;
  const service = {
    listAgentSessions: async () => [],
    agentTabs: async () => {
      tabCalls += 1;
      return { unexpected: true };
    },
  } as unknown as BrowserUseMcpService;
  const app = express();
  app.use('/api/browser-use-mcp', createBrowserUseMcpRouter({
    tokenSource: { getMcpToken: () => BROWSER_TOKEN },
    service,
    deploymentPolicy: () => {
      captures += 1;
      return policy;
    },
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const typed = error as { statusCode?: number; code?: string };
    response.status(typed.statusCode ?? 500).json({ code: typed.code });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const headers = {
      authorization: `Bearer ${BROWSER_TOKEN}`,
      'content-type': 'application/json',
    };
    const readResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/browser-use-mcp/tools/browser_list_sessions`,
      { method: 'POST', headers, body: JSON.stringify({}) },
    );
    assert.equal(readResponse.status, 200);

    const mutationResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/browser-use-mcp/tools/browser_tabs`,
      { method: 'POST', headers, body: JSON.stringify({ action: 'new', sessionId: 'session-1' }) },
    );
    assert.equal(mutationResponse.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  assert.equal(captures, 1);
  assert.equal(tabCalls, 0);
});
