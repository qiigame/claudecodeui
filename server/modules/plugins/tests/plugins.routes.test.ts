import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { AppError } from '@/shared/utils.js';

import { createPluginsRouter } from '../plugins.routes.js';
import { createPluginsService } from '../plugins.service.js';

type Dependencies = Parameters<typeof createPluginsService>[0];

function createDependencies(
  upstreamPort: number,
  overrides: Partial<Dependencies> = {},
): Dependencies {
  return {
    scanPlugins: () => [],
    readConfig: () => ({}),
    saveConfig: () => undefined,
    getPluginDirectory: () => null,
    getPluginsDirectory: () => '/plugins',
    resolveAsset: () => null,
    assetIsFile: () => false,
    contentType: () => 'text/plain',
    install: async () => ({ name: 'plugin' }),
    update: async () => ({ name: 'plugin' }),
    uninstall: async () => undefined,
    startServer: async () => upstreamPort,
    stopServer: async () => undefined,
    getServerPort: () => upstreamPort,
    isServerRunning: () => true,
    getActiveProjectPaths: () => ['/workspace/active'],
    normalizeProjectPath: (projectPath) => projectPath.trim().replace(/\/$/, ''),
    joinPath: (...parts) => parts.join('/'),
    logError: () => undefined,
    ...overrides,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port.');
  }
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

test('Project Stats proxy replaces the raw path spelling with the active canonical path', async () => {
  let upstreamUrl = '';
  const upstream = http.createServer((request, response) => {
    upstreamUrl = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const app = express();
  app.use('/api/plugins', createPluginsRouter(createPluginsService(createDependencies(upstreamPort))));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const response = await fetch(
      `http://127.0.0.1:${hostPort}/api/plugins/project-stats/rpc/stats?path=${encodeURIComponent('/workspace/active ')}&view=summary`,
    );
    assert.equal(response.status, 200);
    const proxiedUrl = new URL(upstreamUrl, 'http://plugin.invalid');
    assert.equal(proxiedUrl.pathname, '/stats');
    assert.deepEqual(proxiedUrl.searchParams.getAll('path'), ['/workspace/active']);
    assert.equal(proxiedUrl.searchParams.get('view'), 'summary');
  } finally {
    await close(host);
    await close(upstream);
  }
});

test('Project Stats proxy rejects repeated path parameters before contacting the plugin', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.end('{}');
  });
  const upstreamPort = await listen(upstream);

  const app = express();
  app.use('/api/plugins', createPluginsRouter(createPluginsService(createDependencies(upstreamPort))));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const response = await fetch(
      `http://127.0.0.1:${hostPort}/api/plugins/project-stats/rpc/stats?path=${encodeURIComponent('/workspace/active')}&path=${encodeURIComponent('/tmp')}`,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'PLUGIN_PROJECT_PATH_DENIED' });
    assert.equal(upstreamRequests, 0);
  } finally {
    await close(host);
    await close(upstream);
  }
});

test('product QA read-only policy keeps plugin discovery readable but blocks management and RPC', async () => {
  const service = createPluginsService(createDependencies(1, {
    scanPlugins: () => [{ name: 'demo', enabled: true }],
    install: async () => {
      throw new Error('install must not be called in read-only mode');
    },
  }));
  const app = express()
    .use(express.json())
    .use('/api/plugins', createPluginsRouter(service, {
      deploymentPolicy: {
        profile: 'product-qa-readonly',
        capabilities: { 'repo-read': true, 'provider-runtime': true },
      },
    }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const listResponse = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/`);
    assert.equal(listResponse.status, 200);

    const installResponse = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/plugin.git' }),
    });
    assert.equal(installResponse.status, 403);
    assert.deepEqual(await installResponse.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });

    const rpcResponse = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/demo/rpc/health`);
    assert.equal(rpcResponse.status, 403);
    assert.deepEqual(await rpcResponse.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
  } finally {
    await close(host);
  }
});

test('product QA read-only policy permits only the project coordination GET mirror', async () => {
  let upstreamRequests = 0;
  let actorChecks = 0;
  let forwardedSecret: string | undefined;
  const upstream = http.createServer((request, response) => {
    upstreamRequests += 1;
    forwardedSecret = request.headers['x-plugin-secret-token'] as string | undefined;
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const service = createPluginsService(createDependencies(upstreamPort, {
    scanPlugins: () => [{ name: 'comic-coordination', enabled: true }],
    readConfig: () => ({
      'comic-coordination': { secrets: { token: 'must-not-leave-host' } },
    }),
  }));
  const app = express()
    .use(express.json())
    .use('/api/plugins', createPluginsRouter(service, {
      deploymentPolicy: {
        profile: 'product-qa-readonly',
        capabilities: { 'plugin.read': true },
      },
      assertActorCanUsePlugins: () => {
        actorChecks += 1;
        throw new Error('read-only project coordination must not require execution identity');
      },
    }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const flowResponse = await fetch(
      `http://127.0.0.1:${hostPort}/api/plugins/comic-coordination/rpc/flow`,
    );
    assert.equal(flowResponse.status, 200);
    assert.deepEqual(await flowResponse.json(), { ok: true });
    assert.equal(upstreamRequests, 1);
    assert.equal(actorChecks, 0);
    assert.equal(forwardedSecret, undefined);

    const writeResponse = await fetch(
      `http://127.0.0.1:${hostPort}/api/plugins/comic-coordination/rpc/flow`,
      { method: 'POST' },
    );
    assert.equal(writeResponse.status, 403);
    assert.deepEqual(await writeResponse.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });

    const unlistedResponse = await fetch(
      `http://127.0.0.1:${hostPort}/api/plugins/comic-coordination/rpc/admin`,
    );
    assert.equal(unlistedResponse.status, 403);
    assert.deepEqual(await unlistedResponse.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
    assert.equal(upstreamRequests, 1);
  } finally {
    await close(host);
    await close(upstream);
  }
});

test('plugin.use permits RPC execution without granting plugin management', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const service = createPluginsService(createDependencies(upstreamPort, {
    scanPlugins: () => [{ name: 'demo', enabled: true }],
    install: async () => {
      throw new Error('plugin.use must not permit installation');
    },
  }));
  const app = express()
    .use(express.json())
    .use('/api/plugins', createPluginsRouter(service, {
      deploymentPolicy: {
        profile: 'platform',
        capabilities: { 'plugin.use': true },
      },
    }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const installResponse = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/plugin.git' }),
    });
    assert.equal(installResponse.status, 403);
    assert.deepEqual(await installResponse.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });

    const rpcResponse = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/demo/rpc/health`);
    assert.equal(rpcResponse.status, 200);
    assert.equal(upstreamRequests, 1);
  } finally {
    await close(host);
    await close(upstream);
  }
});

test('plugin RPC rejects an unverified managed actor even when transported over GET', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const service = createPluginsService(createDependencies(upstreamPort, {
    scanPlugins: () => [{ name: 'demo', enabled: true }],
  }));
  const app = express()
    .use('/api/plugins', createPluginsRouter(service, {
      deploymentPolicy: {
        profile: 'platform',
        capabilities: { 'plugin.use': true },
      },
      assertActorCanUsePlugins: () => {
        throw new AppError('Project identity is pending.', {
          code: 'IDENTITY_ENROLLMENT_REQUIRED',
          statusCode: 403,
        });
      },
    }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const rpcResponse = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/demo/rpc/health`);
    assert.equal(rpcResponse.status, 403);
    assert.deepEqual(await rpcResponse.json(), { code: 'IDENTITY_ENROLLMENT_REQUIRED' });
    assert.equal(upstreamRequests, 0);
  } finally {
    await close(host);
    await close(upstream);
  }
});

test('plugin management writes also require the managed actor callback', async () => {
  let installCalls = 0;
  const service = createPluginsService(createDependencies(1, {
    install: async () => {
      installCalls += 1;
      return { name: 'should-not-install' };
    },
  }));
  const app = express()
    .use(express.json())
    .use('/api/plugins', createPluginsRouter(service, {
      deploymentPolicy: {
        // A writable developer profile can still be explicitly backed by
        // DingTalk SSO. Its capability map permits plugin management, but the
        // actor callback must run before the side effect in a standalone mount.
        profile: 'developer',
        capabilities: { 'plugin.write': true },
      },
      assertActorCanUsePlugins: () => {
        throw new AppError('Project identity is pending.', {
          code: 'IDENTITY_ENROLLMENT_REQUIRED',
          statusCode: 403,
        });
      },
    }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/plugin.git' }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'IDENTITY_ENROLLMENT_REQUIRED' });
    assert.equal(installCalls, 0);
  } finally {
    await close(host);
  }
});

test('plugin RPC revalidates the actor after asynchronous plugin preparation', async () => {
  let upstreamRequests = 0;
  let stopCalls = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const service = createPluginsService(createDependencies(upstreamPort, {
    scanPlugins: () => [{ name: 'demo', enabled: true, server: { entry: 'server.js' } }],
    // Force the route through the async preparation path even though the test
    // plugin is otherwise already considered available.
    getServerPort: () => undefined,
    startServer: async () => upstreamPort,
    stopServer: async () => {
      stopCalls += 1;
    },
  }));
  let actorChecks = 0;
  const app = express()
    .use('/api/plugins', createPluginsRouter(service, {
      deploymentPolicy: {
        profile: 'platform',
        capabilities: { 'plugin.use': true },
      },
      assertActorCanUsePlugins: () => {
        actorChecks += 1;
        if (actorChecks > 1) {
          throw new AppError('Project identity was revoked.', {
            code: 'IDENTITY_ENROLLMENT_REQUIRED',
            statusCode: 403,
          });
        }
      },
    }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const host = http.createServer(app);
  const hostPort = await listen(host);

  try {
    const rpcResponse = await fetch(`http://127.0.0.1:${hostPort}/api/plugins/demo/rpc/health`);
    assert.equal(rpcResponse.status, 403);
    assert.deepEqual(await rpcResponse.json(), { code: 'IDENTITY_ENROLLMENT_REQUIRED' });
    assert.equal(actorChecks, 2);
    assert.equal(upstreamRequests, 0);
    // The denied second check must not leave the process that this request
    // started running in the background.
    assert.equal(stopCalls, 1);
  } finally {
    await close(host);
    await close(upstream);
  }
});
