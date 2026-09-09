import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createCommandsRouter } from '../commands.routes.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const router = createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('product QA read-only policy keeps command listing readable but blocks execution', async () => {
  const router = createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
      access: async () => undefined,
      readdir: async () => [],
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService() as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
    deploymentPolicy: {
      profile: 'product-qa-readonly',
      capabilities: { 'repo-read': true, 'provider-runtime': true },
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const listResponse = await fetch(`http://127.0.0.1:${address.port}/api/commands/list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(listResponse.status, 200);

    const executeResponse = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName: '/status' }),
    });
    assert.equal(executeResponse.status, 403);
    assert.deepEqual(await executeResponse.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('product QA command listing never scans the service account home or returns absolute paths', async () => {
  const scanned: string[] = [];
  const router = createCommandsRouter({
    fileSystem: {
      access: async () => undefined,
      readdir: async (directory: string) => {
        scanned.push(directory);
        return directory === '/srv/projects/project-1/.claude/commands'
          ? [{
              name: 'review.md',
              isDirectory: () => false,
              isFile: () => true,
            }]
          : [];
      },
      readFile: async () => '---\nowner: internal-secret\n---\nReview the change',
      realpath: async (candidate: string) => candidate,
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/srv/cloudcli-service-account',
    appRoot: '/app',
    models: createModelsService() as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
    deploymentPolicy: {
      profile: 'product-qa-readonly',
      capabilities: { 'repo-read': true, 'project-read': true, 'file-read': true },
    },
    resolveProjectPathById: (projectId) => projectId === 'project-1' ? '/srv/projects/project-1' : null,
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-1' }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      custom: Array<Record<string, unknown>>;
    };
    assert.equal(scanned.includes('/srv/cloudcli-service-account/.claude/commands'), false);
    assert.equal(scanned.includes('/srv/projects/project-1/.claude/commands'), true);
    assert.deepEqual(payload.custom, [{
      name: '/review',
      relativePath: 'review.md',
      description: 'Review the change',
      namespace: 'project',
    }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('command listing rejects an unregistered absolute project path', async () => {
  const router = createCommandsRouter({
    fileSystem: {
      access: async () => undefined,
      readdir: async () => [],
      readFile: async () => '',
      realpath: async (candidate: string) => candidate,
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService() as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
    resolveRegisteredProjectPath: () => null,
  });
  const app = express().use(express.json()).use('/api/commands', router);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/etc' }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'PROJECT_PATH_NOT_REGISTERED' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('command listing uses the DB project id instead of a conflicting client path', async () => {
  const scanned: string[] = [];
  const allowedProject = '/workspace/registered';
  const router = createCommandsRouter({
    fileSystem: {
      access: async () => undefined,
      readdir: async (directory: string) => {
        scanned.push(directory);
        return [];
      },
      readFile: async () => '',
      realpath: async (candidate: string) => candidate,
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService() as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
    resolveProjectPathById: (projectId) => projectId === 'project-1' ? allowedProject : null,
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-1', projectPath: '/etc' }),
    });
    assert.equal(response.status, 200);
    assert.ok(scanned.includes(path.join(allowedProject, '.claude', 'commands')));
    assert.equal(scanned.some((directory) => directory.startsWith('/etc')), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('command listing skips a project .claude/commands symlink that escapes the registered root', async () => {
  const scanned: string[] = [];
  const projectRoot = '/srv/projects/project-1';
  const escapedCommandsRoot = '/srv/other-project/.claude/commands';
  const projectCommandsRoot = `${projectRoot}/.claude/commands`;
  const router = createCommandsRouter({
    fileSystem: {
      access: async () => undefined,
      readdir: async (directory: string) => {
        scanned.push(directory);
        return directory === escapedCommandsRoot
          ? [{ name: 'secret.md', isDirectory: () => false, isFile: () => true }]
          : [];
      },
      readFile: async () => '---\ndescription: secret\n---\nprivate',
      realpath: async (candidate: string) => candidate === projectCommandsRoot
        ? escapedCommandsRoot
        : candidate,
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/srv/cloudcli-service-account',
    appRoot: '/app',
    models: createModelsService() as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
    deploymentPolicy: {
      profile: 'product-qa-readonly',
      capabilities: { 'repo-read': true, 'project-read': true, 'file-read': true },
    },
    resolveProjectPathById: (projectId) => projectId === 'project-1' ? projectRoot : null,
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-1' }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { custom: Array<Record<string, unknown>> };
    assert.deepEqual(payload.custom, []);
    assert.equal(scanned.includes(escapedCommandsRoot), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('custom command execution rejects a command tree symlink outside the registered project', async () => {
  const projectRoot = '/srv/projects/project-1';
  const escapedCommandsRoot = '/srv/other-project/.claude/commands';
  const projectCommandsRoot = `${projectRoot}/.claude/commands`;
  let readCalls = 0;
  const router = createCommandsRouter({
    fileSystem: {
      access: async () => undefined,
      readFile: async () => {
        readCalls += 1;
        throw new Error('command content must not be read');
      },
      realpath: async (candidate: string) => {
        if (candidate === projectCommandsRoot) return escapedCommandsRoot;
        return candidate;
      },
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/srv/cloudcli-service-account',
    appRoot: '/app',
    models: createModelsService() as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
    deploymentPolicy: {
      profile: 'developer',
      capabilities: { 'terminal.interactive': true },
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandName: '/private',
        commandPath: `${escapedCommandsRoot}/secret.md`,
        context: { projectPath: projectRoot },
      }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Access denied',
      message: 'Command must be in .claude/commands directory',
    });
    assert.equal(readCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
