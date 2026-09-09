import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import {
  createDeploymentPolicyMiddleware,
  DEPLOYMENT_CAPABILITIES,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { createGitRouter } from '@/modules/git/git.routes.js';

test('configured baseline projects reject Git mutations before spawning Git', async () => {
  let spawnCalls = 0;
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => true,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('Git must not run against a protected baseline');
    }) as Parameters<typeof createGitRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => '/workspace/source',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express().use(express.json()).use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    const body = await response.json() as { code: string };
    assert.equal(response.status, 409);
    assert.equal(body.code, 'SESSION_WORKSPACE_BASELINE_MUTATION_DISABLED');
    assert.equal(spawnCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('numeric project ids cannot bypass the protected-baseline mutation check', async () => {
  let resolvedProjectId: string | null = null;
  let spawnCalls = 0;
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => true,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('Git must not run against a protected baseline');
    }) as Parameters<typeof createGitRouter>[0]['spawnProcess'],
    resolveProjectPathById: (projectId) => {
      resolvedProjectId = projectId;
      return '/workspace/source';
    },
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express().use(express.json()).use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 123 }),
    });
    const body = await response.json() as { code: string };
    assert.equal(response.status, 409);
    assert.equal(body.code, 'SESSION_WORKSPACE_BASELINE_MUTATION_DISABLED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(resolvedProjectId, '123');
  assert.equal(spawnCalls, 0);
});

test('case and trailing-slash variants cannot bypass the protected-baseline guard', async () => {
  let spawnCalls = 0;
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => true,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('Git must not run against a protected baseline');
    }) as Parameters<typeof createGitRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => '/workspace/source',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express().use(express.json()).use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    for (const route of ['/COMMIT', '/commit/']) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/git${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'project-1', message: 'must not run', files: ['README.md'] }),
      });
      const body = await response.json() as { code: string };
      assert.equal(response.status, 409, route);
      assert.equal(body.code, 'SESSION_WORKSPACE_BASELINE_MUTATION_DISABLED', route);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(spawnCalls, 0);
});

test('Git fetch has an independent capability while pull still requires Git write', async () => {
  const policy: DeploymentPolicy = {
    profile: 'platform',
    capabilities: Object.freeze({
      [DEPLOYMENT_CAPABILITIES.GIT_FETCH]: true,
      [DEPLOYMENT_CAPABILITIES.GIT_WRITE]: false,
    }),
  };
  const guardedOperations: string[] = [];
  const capabilityGuard = (operation: string) => {
    guardedOperations.push(operation);
    return createDeploymentPolicyMiddleware({ policy, capability: operation });
  };
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push([...args]);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      if (args[0] === 'symbolic-ref') child.stdout.write('main\n');
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) child.stdout.write('origin/main\n');
      if (args[0] === 'fetch') child.stdout.write('Fetch completed\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: async (): Promise<never> => { throw new Error('unexpected provider call'); },
    queryCursor: async (): Promise<never> => { throw new Error('unexpected provider call'); },
    capabilityGuard,
  });
  const app = express().use(express.json()).use('/api/git', router);
  app.use((error: unknown, _request, response, _next) => {
    response.status(error?.statusCode ?? 500).json({ code: error?.code ?? 'UNKNOWN' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const fetchResponse = await fetch(`http://127.0.0.1:${address.port}/api/git/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    assert.equal(fetchResponse.status, 200);
    assert.match((await fetchResponse.json() as { output: string }).output, /Fetch completed/);

    const commandCountAfterFetch = commands.length;
    const pullResponse = await fetch(`http://127.0.0.1:${address.port}/api/git/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    assert.equal(pullResponse.status, 403);
    assert.equal((await pullResponse.json() as { code: string }).code, 'DEPLOYMENT_CAPABILITY_DENIED');
    assert.equal(commands.length, commandCountAfterFetch);

    const stageResponse = await fetch(`http://127.0.0.1:${address.port}/api/git/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', file: 'README.md' }),
    });
    assert.equal(stageResponse.status, 403);
    assert.equal((await stageResponse.json() as { code: string }).code, 'DEPLOYMENT_CAPABILITY_DENIED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(guardedOperations, [
    DEPLOYMENT_CAPABILITIES.GIT_FETCH,
    DEPLOYMENT_CAPABILITIES.GIT_FETCH,
    DEPLOYMENT_CAPABILITIES.GIT_WRITE,
    DEPLOYMENT_CAPABILITIES.GIT_WRITE,
  ]);
});

test('Git read routes require git.read before resolving or spawning a repository command', async () => {
  const policy: DeploymentPolicy = {
    profile: 'product-qa-readonly',
    capabilities: Object.freeze({
      [DEPLOYMENT_CAPABILITIES.GIT_READ]: false,
    }),
  };
  const guardedOperations: string[] = [];
  let spawnCalls = 0;
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('Git must not run after a denied read');
    }) as Parameters<typeof createGitRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: async (): Promise<never> => { throw new Error('unexpected provider call'); },
    queryCursor: async (): Promise<never> => { throw new Error('unexpected provider call'); },
    capabilityGuard: (operation) => {
      guardedOperations.push(operation);
      return createDeploymentPolicyMiddleware({ policy, capability: operation });
    },
  });
  const app = express().use(express.json()).use('/api/git', router);
  app.use((error: unknown, _request, response, _next) => {
    response.status(error?.statusCode ?? 500).json({ code: error?.code ?? 'UNKNOWN' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/status?project=project-1`);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { code: string }).code, 'DEPLOYMENT_CAPABILITY_DENIED');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(guardedOperations, [DEPLOYMENT_CAPABILITIES.GIT_READ]);
  assert.equal(spawnCalls, 0);
});

test('Git diff rejects a path outside the resolved repository before reading it', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push([...args]);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: {
      access: async () => undefined,
      stat: async () => { throw new Error('file must not be read'); },
      readFile: async () => { throw new Error('file must not be read'); },
    } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/git/diff?project=project-1&file=${encodeURIComponent('../secret.txt')}`,
    );
    // The legacy diff endpoint serializes handler errors as JSON while
    // preserving its historical 200 status; the key assertion is that no
    // path-specific Git/filesystem command runs after validation fails.
    assert.equal(response.status, 200);
    const body = await response.json() as { error: string };
    assert.match(body.error, /path traversal detected/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands, [
    ['rev-parse', '--is-inside-work-tree'],
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--show-toplevel'],
  ]);
});

test('Git diff rejects a repository symlink that resolves outside the repository', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-git-symlink-root-'));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-git-symlink-outside-'));
  const outsideFile = path.join(outsideRoot, 'secret.txt');
  const symlinkPath = path.join(repositoryRoot, 'visible.txt');
  await writeFile(outsideFile, 'do not disclose\n', 'utf8');
  await symlink(outsideFile, symlinkPath);

  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push([...args]);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write(`${repositoryRoot}\n`);
      if (args[0] === 'status' && args.includes('visible.txt')) child.stdout.write('?? visible.txt\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: fsPromises as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => repositoryRoot,
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/git/diff?project=project-1&file=visible.txt`,
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { error: string; diff?: string };
    assert.match(body.error, /outside the repository/i);
    assert.equal(body.diff, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([
      rm(repositoryRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }

  // The path-specific status lookup is allowed; no filesystem read or second
  // status/diff command should run after canonical containment rejects it.
  assert.deepEqual(commands, [
    ['rev-parse', '--is-inside-work-tree'],
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--show-toplevel'],
    ['status', '--porcelain', '--', 'visible.txt'],
  ]);
});

test('git init does not run when repository validation fails for an execution error', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => child.emit('error', Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })));
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    const body = await response.json() as { success: boolean; error: string };
    assert.equal(body.success, false);
    assert.match(body.error, /permission denied/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands, [['rev-parse', '--is-inside-work-tree']]);
});

test('delete branch parses force and uses Git force deletion', async () => {
  const commands: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    commands.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('--is-inside-work-tree')) child.stdout.write('true\n');
      if (args.includes('--show-toplevel')) child.stdout.write('/workspace/repo\n');
      if (args.includes('--show-current')) child.stdout.write('main\n');
      if (args.includes('-D')) child.stdout.write('Deleted branch feature/unmerged.\n');
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: true }),
    });
    const body = await response.json() as { success: boolean; output: string };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.match(body.output, /Deleted branch/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(commands.at(-1), ['branch', '-D', '--', 'feature/unmerged']);
});

test('delete branch rejects a non-boolean force value before running Git', async () => {
  const spawnProcess = (() => {
    throw new Error('Git must not run for invalid input');
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/delete-branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', branch: 'feature/unmerged', force: 'yes' }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 400);
    assert.equal(body.error, 'force must be a boolean');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('legacy Git read errors do not expose filesystem paths or subprocess secrets', async () => {
  const secretPath = '/Users/macos/private-project/remote-token.txt';
  const spawnProcess = ((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('error', new Error(`permission denied: ${secretPath}`));
    });
    return child;
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];
  const router = createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: { access: async () => undefined } as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repo',
    queryClaude: async (): Promise<never> => { throw new Error('unexpected provider call'); },
    queryCursor: async (): Promise<never> => { throw new Error('unexpected provider call'); },
  });
  const app = express().use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/git/branches?project=project-1`);
    const body = await response.json() as { error: string };
    assert.equal(response.status, 200);
    assert.equal(body.error, 'Permission denied while accessing the repository.');
    assert.equal(body.error.includes(secretPath), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
