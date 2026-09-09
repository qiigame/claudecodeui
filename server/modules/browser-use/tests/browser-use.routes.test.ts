import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import {
  createDeploymentPolicyMiddleware,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';

import {
  createBrowserUseRouter,
  type BrowserUseRouteService,
} from '../browser-use.routes.js';

const defaultBrowserStatus = {
  enabled: true,
  runtime: 'local' as const,
  available: true,
  playwrightInstalled: true,
  chromiumInstalled: true,
  installInProgress: false,
  sessionCount: 0,
  message: 'Browser runtime is available.',
};

function createService(overrides: Partial<BrowserUseRouteService> = {}): BrowserUseRouteService {
  return {
    getStatus: async () => ({ ...defaultBrowserStatus }),
    getSettings: async () => ({ enabled: true }),
    updateSettings: async () => ({ enabled: true }),
    installRuntime: async () => ({
      success: true,
      message: 'installed',
      status: { ...defaultBrowserStatus },
    }),
    listSessions: async () => [],
    stopSession: async () => ({ stopped: true }),
    deleteSession: async () => ({ deleted: true }),
    ...overrides,
  } as BrowserUseRouteService;
}

async function withServer(
  service: BrowserUseRouteService,
  run: (baseUrl: string) => Promise<void>,
  policyEnvironment: Readonly<Record<string, string | undefined>> = {
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  },
): Promise<void> {
  const policy = parseDeploymentPolicy(policyEnvironment);
  const app = express();
  app.use(express.json());
  app.use(createDeploymentPolicyMiddleware({ policy }));
  app.use('/api/browser-use', createBrowserUseRouter({
    service,
    // Keep the existing route tests focused on deployment capability behavior;
    // managed session-list ACL coverage is exercised explicitly below.
    requireManagedSessionListAdmin: false,
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const typed = error as { statusCode?: number; code?: string; message?: string };
    response.status(typed.statusCode ?? 500).json({ code: typed.code, message: typed.message });
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

async function withManagedSessionListServer(
  service: BrowserUseRouteService,
  user: unknown,
  run: (baseUrl: string) => Promise<void>,
  assertSessionListAccess?: (request: express.Request) => void,
): Promise<void> {
  const policy = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' });
  const app = express();
  app.use(express.json());
  app.use(createDeploymentPolicyMiddleware({ policy }));
  app.use((request, _response, next) => {
    (request as express.Request & { user?: unknown }).user = user;
    next();
  });
  app.use('/api/browser-use', createBrowserUseRouter({
    service,
    requireManagedSessionListAdmin: true,
    assertSessionListAccess,
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const typed = error as { statusCode?: number; code?: string; message?: string };
    response.status(typed.statusCode ?? 500).json({ code: typed.code, message: typed.message });
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

test('Browser read endpoints remain available in product/QA read-only mode', async () => {
  let statusCalls = 0;
  await withServer(createService({
    getStatus: async () => {
      statusCalls += 1;
      return { ...defaultBrowserStatus };
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: defaultBrowserStatus });
  });
  assert.equal(statusCalls, 1);
});

test('managed Browser session listing denies pending or non-admin actors before touching shared sessions', async () => {
  let listCalls = 0;
  const service = createService({
    listSessions: async () => {
      listCalls += 1;
      return [{ id: 'shared-1' }] as never;
    },
  });

  await withManagedSessionListServer(service, {
    id: 7,
    actor: {
      userId: 7,
      provider: 'dingtalk',
      personId: null,
      identityStatus: 'pending',
    },
    permissions: { manageSettings: false },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      code: 'BROWSER_SESSION_LIST_ACCESS_DENIED',
      message: 'Browser session listing requires a verified DingTalk settings administrator.',
    });
  });

  assert.equal(listCalls, 0);
});

test('managed Browser session listing allows only a verified DingTalk settings administrator', async () => {
  let listCalls = 0;
  const service = createService({
    listSessions: async () => {
      listCalls += 1;
      return [{ id: 'shared-1' }] as never;
    },
  });

  await withManagedSessionListServer(service, {
    id: 7,
    actor: {
      userId: 7,
      provider: 'dingtalk',
      personId: 'person-7',
      identityStatus: 'verified',
    },
    permissions: { manageSettings: true },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.deepEqual(await response.json(), {
      success: true,
      data: { sessions: [{ id: 'shared-1' }] },
    });
  });

  assert.equal(listCalls, 1);
});

test('managed Browser session listing denies a verified non-admin actor', async () => {
  let listCalls = 0;
  const service = createService({
    listSessions: async () => {
      listCalls += 1;
      return [{ id: 'shared-1' }] as never;
    },
  });

  await withManagedSessionListServer(service, {
    id: 7,
    actor: {
      userId: 7,
      provider: 'dingtalk',
      personId: 'person-7',
      identityStatus: 'verified',
    },
    permissions: { manageSettings: false },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      code: 'BROWSER_SESSION_LIST_ACCESS_DENIED',
      message: 'Browser session listing requires a verified DingTalk settings administrator.',
    });
  });

  assert.equal(listCalls, 0);
});

test('local Browser session listing remains compatible without a human actor ACL', async () => {
  let listCalls = 0;
  await withServer(createService({
    listSessions: async () => {
      listCalls += 1;
      return [{ id: 'local-1' }] as never;
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/sessions`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: { sessions: [{ id: 'local-1' }] },
    });
  });
  assert.equal(listCalls, 1);
});

test('Browser lifecycle mutations are denied before the service in read-only mode', async () => {
  let updateCalls = 0;
  let installCalls = 0;
  let stopCalls = 0;
  let deleteCalls = 0;
  const service = createService({
    updateSettings: async () => {
      updateCalls += 1;
      return { enabled: true };
    },
    installRuntime: async () => {
      installCalls += 1;
      return {
        success: true,
        message: 'installed',
        status: { ...defaultBrowserStatus },
      };
    },
    stopSession: async () => {
      stopCalls += 1;
      return { stopped: true };
    },
    deleteSession: async () => {
      deleteCalls += 1;
      return { deleted: true };
    },
  });

  await withServer(service, async (baseUrl) => {
    const requests = [
      fetch(`${baseUrl}/api/browser-use/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      fetch(`${baseUrl}/api/browser-use/runtime/install`, { method: 'POST' }),
      fetch(`${baseUrl}/api/browser-use/sessions/session-1/stop`, { method: 'POST' }),
      fetch(`${baseUrl}/api/browser-use/sessions/session-1`, { method: 'DELETE' }),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      assert.equal(response.status, 403);
      const payload = await response.json() as { code?: string };
      assert.equal(payload.code, 'DEPLOYMENT_CAPABILITY_DENIED');
    }
  });

  assert.equal(updateCalls, 0);
  assert.equal(installCalls, 0);
  assert.equal(stopCalls, 0);
  assert.equal(deleteCalls, 0);
});

test('Browser settings require MCP write even when Browser use is enabled', async () => {
  let updateCalls = 0;
  const service = createService({
    updateSettings: async () => {
      updateCalls += 1;
      return { enabled: true };
    },
  });

  await withServer(service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browser-use/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    assert.equal(response.status, 403);
    const payload = await response.json() as { code?: string };
    assert.equal(payload.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  }, {
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'mcp.write=false',
  });

  assert.equal(updateCalls, 0);
});
