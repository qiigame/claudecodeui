import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createCommandsRouter } from '@/modules/commands/index.js';
import {
  createDeploymentPolicyGuard,
  captureDeploymentPolicy,
  mountProtectedApiRoute,
  mountPreApiKeyCapabilityRoute,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { createPluginsRouter } from '@/modules/plugins/index.js';
import { createProviderRouter } from '@/modules/providers/index.js';
import { createTaskmasterRouter } from '@/modules/taskmaster/index.js';
import { createScheduledMessagesRouter } from '@/modules/scheduled-messages/index.js';
import { createWorktreesRouter } from '@/modules/worktrees/index.js';
import { AppError } from '@/shared/utils.js';

const readonlyPolicy = parseDeploymentPolicy({
  CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
});
const developerPolicy = parseDeploymentPolicy({
  CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
});

function errorMiddleware(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const appError = error instanceof AppError ? error : null;
  response.status(appError?.statusCode ?? 500).json({
    code: appError?.code ?? 'INTERNAL_ERROR',
  });
}

async function requestThrough(
  router: express.Router,
  configureRequest: (request: Request) => void,
  mountPath: string,
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    configureRequest(request);
    next();
  });
  // Feature routers expose paths relative to their production mount (for
  // example `/execute` under `/api/commands`). Mounting at `/` would make the
  // `/api/...` probes below fall through to Express' 404 page and could make a
  // policy assertion look green without ever executing the guard.
  app.use(mountPath, router);
  app.use(errorMiddleware);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function commandDependencies(
  deploymentPolicy: Parameters<typeof createCommandsRouter>[0]['deploymentPolicy'],
) {
  return {
    fileSystem: {
      access: async () => undefined,
      readdir: async () => [],
      readFile: async () => '',
      realpath: async (candidate: string) => candidate,
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/cloudcli-test',
    appRoot: '/app',
    models: {
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
      resolveSessionModel: async () => ({ model: 'default' }),
    } as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({
        rss: 0,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0,
      }),
      version: 'v22',
      platform: 'linux' as NodeJS.Platform,
      pid: 1,
    },
    deploymentPolicy,
  };
}

test('captureDeploymentPolicy evaluates an environment fallback once', { concurrency: false }, () => {
  const previousProfile = process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
  try {
    process.env.CLOUDCLI_DEPLOYMENT_PROFILE = 'product-qa-readonly';
    const captured = captureDeploymentPolicy();
    process.env.CLOUDCLI_DEPLOYMENT_PROFILE = 'developer';
    assert.equal(captured.profile, 'product-qa-readonly');
    assert.equal(captured.capabilities['git.write'], false);
  } finally {
    if (previousProfile === undefined) delete process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
    else process.env.CLOUDCLI_DEPLOYMENT_PROFILE = previousProfile;
  }
});

test('commands capture a policy source once and prefer a trusted request snapshot', async () => {
  let sourceCalls = 0;
  const router = createCommandsRouter(commandDependencies(() => {
    sourceCalls += 1;
    return developerPolicy;
  }));
  const result = await requestThrough(
    router,
    (request) => {
      (request as Request & { deploymentPolicy?: unknown }).deploymentPolicy = readonlyPolicy;
    },
    '/api/commands',
    '/api/commands/execute',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName: '/status' }),
    },
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.equal(sourceCalls, 1);
});

test('plugins capture a policy source once and do not let a request reopen readonly management', async () => {
  let sourceCalls = 0;
  let installCalls = 0;
  const service = {
    install: async () => {
      installCalls += 1;
      return { name: 'unexpected' };
    },
  } as never;
  const router = createPluginsRouter(service, {
    deploymentPolicy: () => {
      sourceCalls += 1;
      return developerPolicy;
    },
  });
  const result = await requestThrough(
    router,
    (request) => {
      (request as Request & { deploymentPolicy?: unknown }).deploymentPolicy = readonlyPolicy;
    },
    '/api/plugins',
    '/api/plugins/install',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.invalid/plugin.git' }),
    },
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.equal(sourceCalls, 1);
  assert.equal(installCalls, 0);
});

test('providers capture a policy source once and apply the trusted request snapshot to writes', async () => {
  let sourceCalls = 0;
  const router = createProviderRouter({
    deploymentPolicy: () => {
      sourceCalls += 1;
      return developerPolicy;
    },
  });
  const result = await requestThrough(
    router,
    (request) => {
      (request as Request & { deploymentPolicy?: unknown }).deploymentPolicy = readonlyPolicy;
    },
    '/api/providers',
    '/api/providers/claude/models',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'test-model', model: 'Test model' }),
    },
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.equal(sourceCalls, 1);
});

test('TaskMaster external capability guards receive one startup policy and honor request policy', async () => {
  let sourceCalls = 0;
  let guardPolicy: unknown;
  let spawnCalls = 0;
  const router = createTaskmasterRouter({
    fileSystem: { constants: { F_OK: 0 } } as typeof import('node:fs'),
    fileSystemPromises: {} as typeof import('node:fs/promises'),
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('TaskMaster must not spawn after policy denial');
    }) as never,
    resolveProjectPathById: () => '/workspace/project',
    taskmasterService: {
        detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
    deploymentPolicy: () => {
      sourceCalls += 1;
      return developerPolicy;
    },
    capabilityGuard: (operation, policy) => {
      guardPolicy = policy;
      return createDeploymentPolicyGuard({ capability: operation });
    },
  });
  const result = await requestThrough(
    router,
    (request) => {
      (request as Request & { deploymentPolicy?: unknown }).deploymentPolicy = readonlyPolicy;
    },
    '/api/taskmaster',
    '/api/taskmaster/init/project-1',
    { method: 'POST' },
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.equal(sourceCalls, 1);
  assert.equal(guardPolicy, developerPolicy);
  assert.equal(spawnCalls, 0);
});

test('scheduled messages and worktrees capture policy sources at construction', () => {
  let sourceCalls = 0;
  const policySource = () => {
    sourceCalls += 1;
    return readonlyPolicy;
  };

  createScheduledMessagesRouter({ deploymentPolicy: policySource });
  createWorktreesRouter({} as never, { deploymentPolicy: policySource });

  assert.equal(sourceCalls, 2);
});

test('production protected mount keeps auth and capability guards ahead of the feature router', async () => {
  let authenticateCalls = 0;
  let handlerCalls = 0;
  const app = express();
  app.use(express.json());

  const authenticate = (_request: Request, _response: Response, next: NextFunction) => {
    authenticateCalls += 1;
    next();
  };
  const mutationGuard = createDeploymentPolicyGuard({
    policy: readonlyPolicy,
    capability: 'git.write',
    errorCode: 'DEPLOYMENT_CAPABILITY_DENIED',
  });
  const featureRouter = express.Router();
  featureRouter.post('/push', (_request, response) => {
    handlerCalls += 1;
    response.json({ ok: true });
  });

  // This is the same mount shape used by server/index.ts. Keeping the
  // production prefix here catches the old false-green pattern where a test
  // mounted a feature router at `/` and only observed Express' 404 response.
  mountProtectedApiRoute(
    app,
    '/api/git',
    authenticate,
    featureRouter,
    mutationGuard,
  );
  app.use(errorMiddleware);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/push`, {
      method: 'POST',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
    });
    assert.equal(authenticateCalls, 1);
    assert.equal(handlerCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('legacy Agent capability wins over the installation API key in readonly production mounts', async () => {
  let installationKeyChecks = 0;
  let agentKeyChecks = 0;
  let handlerCalls = 0;
  const app = express();
  app.use(express.json());

  const agentRouter = express.Router();
  agentRouter.use((request, response, next) => {
    agentKeyChecks += 1;
    if (request.headers['x-api-key'] !== 'agent-key') {
      response.status(401).json({ error: 'Agent API key required' });
      return;
    }
    next();
  });
  agentRouter.post('/', (_request, response) => {
    handlerCalls += 1;
    response.json({ ok: true });
  });

  // This mirrors the production ordering: the route-specific capability is
  // mounted before the helper's installation-wide `/api` key middleware,
  // while the Agent router itself remains below both boundaries.
  mountPreApiKeyCapabilityRoute(
    app,
    '/api/agent',
    createDeploymentPolicyGuard({
      policy: readonlyPolicy,
      capability: 'agent.use',
      errorCode: 'DEPLOYMENT_CAPABILITY_DENIED',
    }),
  );
  app.use('/api', (request, response, next) => {
    installationKeyChecks += 1;
    if (request.headers['x-api-key'] !== 'install-key') {
      response.status(401).json({ error: 'Installation API key required' });
      return;
    }
    next();
  });
  app.use('/api/agent', agentRouter);
  app.use(errorMiddleware);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const request = (headers: Record<string, string> = {}) => fetch(
      `http://127.0.0.1:${address.port}/api/agent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({}),
      },
    );
    const missingKeyResponse = await request();
    assert.equal(missingKeyResponse.status, 403);
    assert.deepEqual(await missingKeyResponse.json(), {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
    });

    const wrongKeyResponse = await request({ 'x-api-key': 'wrong-key' });
    assert.equal(wrongKeyResponse.status, 403);
    assert.deepEqual(await wrongKeyResponse.json(), {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(installationKeyChecks, 0);
  assert.equal(agentKeyChecks, 0);
  assert.equal(handlerCalls, 0);
});

test('legacy Agent developer mounts still pass through installation and Agent key checks', async () => {
  let installationKeyChecks = 0;
  let agentKeyChecks = 0;
  let handlerCalls = 0;
  const app = express();
  const agentRouter = express.Router();
  agentRouter.use((request, response, next) => {
    agentKeyChecks += 1;
    if (request.headers['x-api-key'] !== 'shared-key') {
      response.status(401).json({ error: 'Agent API key required' });
      return;
    }
    next();
  });
  agentRouter.post('/', (_request, response) => {
    handlerCalls += 1;
    response.json({ ok: true });
  });

  mountPreApiKeyCapabilityRoute(
    app,
    '/api/agent',
    createDeploymentPolicyGuard({
      policy: developerPolicy,
      capability: 'agent.use',
      errorCode: 'DEPLOYMENT_CAPABILITY_DENIED',
    }),
  );
  app.use('/api', (request, response, next) => {
    installationKeyChecks += 1;
    if (request.headers['x-api-key'] !== 'shared-key') {
      response.status(401).json({ error: 'Installation API key required' });
      return;
    }
    next();
  });
  app.use('/api/agent', agentRouter);
  app.use(errorMiddleware);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const request = (headers: Record<string, string> = {}) => fetch(
      `http://127.0.0.1:${address.port}/api/agent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({}),
      },
    );

    // A writable deployment still reaches the installation-wide key first.
    assert.equal((await request()).status, 401);
    assert.equal((await request({ 'x-api-key': 'wrong-key' })).status, 401);
    assert.equal((await request({ 'x-api-key': 'shared-key' })).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(installationKeyChecks, 3);
  // Only the request with the valid installation key reaches the Agent's own
  // API-key validator; the successful request then reaches the handler.
  assert.equal(agentKeyChecks, 1);
  assert.equal(handlerCalls, 1);
});
