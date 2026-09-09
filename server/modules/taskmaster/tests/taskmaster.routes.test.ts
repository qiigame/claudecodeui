import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express from 'express';

import { connectedClients } from '@/modules/websocket/index.js';

import {
  createTaskmasterRouter,
  redactTaskmasterMcpStatus,
  shouldRedactTaskmasterMcpStatus,
} from '../taskmaster.routes.js';
import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';

test('tasks route resolves project ids through the injected project adapter', async () => {
  const resolvedIds: string[] = [];
  const router = createTaskmasterRouter({
    fileSystem: {} as typeof import('node:fs'),
    fileSystemPromises: {} as typeof import('node:fs/promises'),
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: (projectId) => { resolvedIds.push(projectId); return null; },
    taskmasterService: {
      detectMcpServer: async () => ({
        hasMCPServer: false,
        reason: 'Not configured',
        hasConfig: false,
      }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/tasks/project-1`);
    assert.equal(response.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.deepEqual(resolvedIds, ['project-1']);
});

test('tasks route does not read a task file symlinked outside the selected project', async () => {
  const projectPath = '/workspace/project';
  const taskPath = `${projectPath}/.taskmaster/tasks/tasks.json`;
  let readCalls = 0;
  const router = createTaskmasterRouter({
    fileSystem: {} as typeof import('node:fs'),
    fileSystemPromises: {
      realpath: async (candidatePath: string) => (
        candidatePath === taskPath ? '/workspace/secret/tasks.json' : candidatePath
      ),
      stat: async () => ({ isFile: () => true }),
      access: async () => undefined,
      readFile: async () => {
        readCalls += 1;
        return JSON.stringify({ tasks: [{ id: 1, title: 'secret' }] });
      },
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => { throw new Error('TaskMaster process must not run'); }) as unknown as
      Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => projectPath,
    taskmasterService: {
      detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/tasks/project-1`);
    assert.equal(response.status, 200);
    const body = await response.json() as { tasks: unknown[]; message?: string };
    assert.deepEqual(body.tasks, []);
    assert.equal(body.message, 'No tasks.json file found');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(readCalls, 0);
});

test('MCP status route delegates detection to the injected TaskMaster service', async () => {
  let detectionCount = 0;
  const router = createTaskmasterRouter({
    fileSystem: {} as typeof import('node:fs'),
    fileSystemPromises: {} as typeof import('node:fs/promises'),
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => null,
    taskmasterService: {
      detectMcpServer: async () => {
        detectionCount += 1;
        return {
          hasMCPServer: true,
          isConfigured: true,
          hasApiKeys: false,
          scope: 'user',
          config: {
            command: 'npx',
            args: ['-y', 'task-master-ai'],
            url: null,
            envVars: [],
            type: 'stdio',
          },
        };
      },
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/mcp-status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      hasMCPServer: true,
      isConfigured: true,
      hasApiKeys: false,
      scope: 'user',
      config: {
        command: 'npx',
        args: ['-y', 'task-master-ai'],
        url: null,
        envVars: [],
        type: 'stdio',
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(detectionCount, 1);
});

test('MCP status failures return a stable message without logging raw error details', async () => {
  const logEntries: unknown[] = [];
  const router = createTaskmasterRouter({
    fileSystem: {} as typeof import('node:fs'),
    fileSystemPromises: {} as typeof import('node:fs/promises'),
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => null,
    logger: {
      error: (...args: unknown[]) => logEntries.push(args),
      warn: () => {},
      info: () => {},
    },
    taskmasterService: {
      detectMcpServer: async () => {
        throw Object.assign(new Error('MCP_TOKEN_MARKER /srv/cloudcli/.claude.json'), {
          code: 'EACCES',
        });
      },
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/mcp-status`);
    assert.equal(response.status, 500);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, {
      error: 'Failed to detect TaskMaster MCP server',
      message: 'TaskMaster operation failed.',
      reasonCode: 'TASKMASTER_UNEXPECTED_ERROR',
    });
    assert.equal(JSON.stringify(body).includes('MCP_TOKEN_MARKER'), false);
    assert.equal(JSON.stringify(body).includes('/srv/cloudcli'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(JSON.stringify(logEntries).includes('MCP_TOKEN_MARKER'), false);
  assert.equal(JSON.stringify(logEntries).includes('/srv/cloudcli'), false);
  assert.match(JSON.stringify(logEntries), /EACCES/);
});

test('managed TaskMaster MCP status omits executable paths and inline credentials', () => {
  const status = {
    hasMCPServer: true,
    isConfigured: true,
    hasApiKeys: true,
    scope: 'local',
    projectPath: '/srv/cloudcli/projects-ro/demo',
    configPath: '/srv/cloudcli/state/provider-ro/claude/.claude.json',
    config: {
      command: 'node /srv/tools/task-master --token=secret-token',
      args: ['--header', 'Authorization: Bearer secret-token'],
      url: 'https://mcp.example.test/run?token=secret-token',
      envVars: ['TASKMASTER_API_KEY'],
      type: 'http',
    },
    availableServers: ['task-master-ai', 'other-internal-server'],
  };

  const redacted = redactTaskmasterMcpStatus(status);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('/srv/'), false);
  assert.deepEqual(redacted, {
    hasMCPServer: true,
    isConfigured: true,
    hasApiKeys: true,
    scope: 'local',
    config: {
      type: 'http',
      hasCommand: true,
      hasUrl: true,
      envVarCount: 1,
    },
  });
});

test('TaskMaster status redaction follows the deployment policy', () => {
  const readonlyRequest = {
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  } as never;
  assert.equal(shouldRedactTaskmasterMcpStatus(readonlyRequest), true);

  const localRequest = {
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    }),
  } as never;
  assert.equal(shouldRedactTaskmasterMcpStatus(localRequest), false);

  const managedDingTalkRequest = {
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    }),
    user: {
      actor: { provider: 'dingtalk' },
      permissions: { manageSettings: false },
    },
  } as never;
  assert.equal(shouldRedactTaskmasterMcpStatus(managedDingTalkRequest), true);
});

test('readonly installation status reports policy denial without spawning the TaskMaster CLI', async () => {
  let spawnCount = 0;
  let detectionCount = 0;
  const router = createTaskmasterRouter({
    fileSystem: {} as typeof import('node:fs'),
    fileSystemPromises: {} as typeof import('node:fs/promises'),
    spawnProcess: (() => {
      spawnCount += 1;
      throw new Error('TaskMaster CLI must not be spawned in readonly mode');
    }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => null,
    taskmasterService: {
      detectMcpServer: async () => {
        detectionCount += 1;
        return { hasMCPServer: false, reason: 'Not configured', hasConfig: false };
      },
    },
  });
  const app = express();
  app.use((request, _response, next) => {
    // Keep the fixture aligned with the real policy parser.  The route has a
    // dedicated `mcp.read` guard; a hand-written partial capability map would
    // accidentally turn this read-only status assertion into a 403 unrelated
    // to the behavior under test.
    (request as typeof request & { deploymentPolicy?: unknown }).deploymentPolicy = parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    });
    next();
  });
  app.use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/installation-status`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      installation: { isInstalled: boolean; version: string | null; reason: string };
      isReady: boolean;
    };
    assert.deepEqual(body.installation, {
      isInstalled: false,
      installPath: null,
      version: null,
      reason: 'TaskMaster CLI inspection is disabled by the deployment policy',
    });
    assert.equal(body.isReady, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(spawnCount, 0);
  assert.equal(detectionCount, 1);
});

test('PRD templates require project read capability and remain available to product/QA', async () => {
  const createRouter = (deploymentPolicy: ReturnType<typeof parseDeploymentPolicy>) =>
    createTaskmasterRouter({
      fileSystem: {} as typeof import('node:fs'),
      fileSystemPromises: {} as typeof import('node:fs/promises'),
      spawnProcess: (() => {
        throw new Error('TaskMaster process must not run while reading built-in templates');
      }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
      deploymentPolicy,
      resolveProjectPathById: () => null,
      taskmasterService: {
        detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
      },
    });

  const readonlyPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  const withoutProjectRead = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: '{"project.read":false}',
  });

  for (const [policy, expectedStatus] of [
    [readonlyPolicy, 200],
    [withoutProjectRead, 403],
  ] as const) {
    const app = express().use('/api/taskmaster', createRouter(policy));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/prd-templates`);
      assert.equal(response.status, expectedStatus);
      if (expectedStatus === 200) {
        const body = await response.json() as { templates?: unknown[] };
        assert.ok(Array.isArray(body.templates));
        assert.ok(body.templates.length > 0);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test('managed writable actors do not receive an absolute path from PRD success responses', async () => {
  const projectPath = '/srv/cloudcli/projects-ro/demo';
  const developerPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });
  const router = createTaskmasterRouter({
    fileSystem: { constants: { F_OK: 0 } } as typeof import('node:fs'),
    fileSystemPromises: {
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      stat: async () => ({
        size: 12,
        birthtime: new Date('2026-09-06T00:00:00.000Z'),
        mtime: new Date('2026-09-06T00:00:00.000Z'),
      }),
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => {
      throw new Error('TaskMaster CLI must not run while saving a PRD');
    }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    deploymentPolicy: developerPolicy,
    resolveProjectPathById: () => projectPath,
    taskmasterService: {
      detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const policyRequest = request as typeof request & {
      deploymentPolicy?: unknown;
      user?: unknown;
    };
    policyRequest.deploymentPolicy = developerPolicy;
    // A writable developer profile can still be behind DingTalk SSO. This is
    // the managed-user case where the legacy response field must be redacted.
    policyRequest.user = {
      actor: { provider: 'dingtalk' },
      permissions: { manageSettings: false },
    };
    next();
  });
  app.use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/prd/project-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'brief.md', content: '# Brief' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    assert.equal(Object.hasOwn(body, 'projectPath'), false);
    assert.equal(serialized.includes(projectPath), false);
    assert.equal(body.filePath, '.taskmaster/docs/brief.md');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('installation status hides CLI stderr and spawn error details', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const logEntries: unknown[] = [];
  const router = createTaskmasterRouter({
    fileSystem: {} as typeof import('node:fs'),
    fileSystemPromises: {} as typeof import('node:fs/promises'),
    spawnProcess: (() => {
      process.nextTick(() => {
        child.stderr.write('/srv/cloudcli/bin/task-master secret INSTALL_MARKER');
        child.emit('error', new Error('spawn failed INSTALL_MARKER'));
        child.emit('close', 1);
      });
      return child;
    }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => null,
    logger: {
      error: (...args: unknown[]) => logEntries.push(args),
      warn: () => {},
      info: () => {},
    },
    taskmasterService: {
      detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/installation-status`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('INSTALL_MARKER'), false);
    assert.equal(serialized.includes('/srv/cloudcli'), false);
    assert.deepEqual(body.installation && {
      isInstalled: (body.installation as Record<string, unknown>).isInstalled,
      installPath: (body.installation as Record<string, unknown>).installPath,
      version: (body.installation as Record<string, unknown>).version,
      reason: (body.installation as Record<string, unknown>).reason,
      reasonCode: (body.installation as Record<string, unknown>).reasonCode,
    }, {
      isInstalled: false,
      installPath: null,
      version: null,
      reason: 'TaskMaster CLI unavailable.',
      reasonCode: 'TASKMASTER_CLI_UNAVAILABLE',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(JSON.stringify(logEntries).includes('INSTALL_MARKER'), false);
  assert.equal(JSON.stringify(logEntries).includes('/srv/cloudcli'), false);
});

test('TaskMaster PRD routes reject traversal filenames before filesystem or process side effects', async () => {
  let filesystemCalls = 0;
  let spawnCalls = 0;
  let projectLookups = 0;
  const router = createTaskmasterRouter({
    fileSystem: { constants: { F_OK: 0, R_OK: 4 } } as typeof import('node:fs'),
    fileSystemPromises: {
      access: async () => { filesystemCalls += 1; },
      mkdir: async () => { filesystemCalls += 1; },
      writeFile: async () => { filesystemCalls += 1; },
      readFile: async () => { filesystemCalls += 1; return ''; },
      stat: async () => { filesystemCalls += 1; return {}; },
      realpath: async (candidatePath: string) => candidatePath,
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('TaskMaster process must not run for an invalid filename');
    }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => {
      projectLookups += 1;
      return '/workspace/project';
    },
    taskmasterService: {
      detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
  });
  const app = express().use(express.json()).use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/taskmaster`;
    const getResponse = await fetch(`${baseUrl}/prd/project-1/${encodeURIComponent('../../outside.md')}`);
    assert.equal(getResponse.status, 400);
    const invalidBody = await getResponse.json() as Record<string, unknown>;
    assert.equal(JSON.stringify(invalidBody).includes('../../outside.md'), false);
    assert.equal(invalidBody.reasonCode, 'TASKMASTER_INVALID_FILENAME');

    const createResponse = await fetch(`${baseUrl}/prd/project-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: '../outside.md', content: 'must stay in docs' }),
    });
    assert.equal(createResponse.status, 400);

    const parseResponse = await fetch(`${baseUrl}/parse-prd/project-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: '..\\outside.md' }),
    });
    assert.equal(parseResponse.status, 400);

    const applyResponse = await fetch(`${baseUrl}/apply-template/project-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'web-app', fileName: '../../outside.md' }),
    });
    assert.equal(applyResponse.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(filesystemCalls, 0);
  assert.equal(spawnCalls, 0);
  // The create route validates before looking up a project; the other routes
  // still resolve the DB project before applying their scoped filename check.
  assert.equal(projectLookups, 3);
});

test('TaskMaster PRD reads reject symlink targets outside the project docs directory', async () => {
  const projectPath = '/workspace/project';
  const docsPath = `${projectPath}/.taskmaster/docs`;
  const linkedPath = `${docsPath}/linked.md`;
  let readCalls = 0;
  const router = createTaskmasterRouter({
    fileSystem: { constants: { R_OK: 4 } } as typeof import('node:fs'),
    fileSystemPromises: {
      realpath: async (candidatePath: string) => {
        if (candidatePath === linkedPath) return '/workspace/secret.md';
        return candidatePath;
      },
      access: async () => { throw new Error('read should not be attempted'); },
      readFile: async () => { readCalls += 1; return 'secret'; },
      stat: async () => ({ size: 6, birthtime: new Date(), mtime: new Date() }),
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => projectPath,
    taskmasterService: {
      detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/prd/project-1/linked.md`);
    assert.equal(response.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(readCalls, 0);
});

test('TaskMaster PRD reads reject a docs directory symlink outside the project root', async () => {
  const projectPath = '/workspace/project';
  const docsPath = `${projectPath}/.taskmaster/docs`;
  let readCalls = 0;
  let statCalls = 0;
  const router = createTaskmasterRouter({
    fileSystem: { constants: { R_OK: 4 } } as typeof import('node:fs'),
    fileSystemPromises: {
      realpath: async (candidatePath: string) => {
        if (candidatePath === docsPath) return '/workspace/shared-docs';
        if (candidatePath === `${docsPath}/linked.md`) return '/workspace/shared-docs/linked.md';
        return candidatePath;
      },
      access: async () => undefined,
      readdir: async () => ['linked.md'],
      stat: async () => {
        statCalls += 1;
        return { isFile: () => true, size: 6, birthtime: new Date(), mtime: new Date() };
      },
      readFile: async () => {
        readCalls += 1;
        return 'secret';
      },
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => projectPath,
    taskmasterService: {
      detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/prd/project-1`);
    assert.equal(response.status, 403);
    const body = await response.json() as { code: string };
    assert.equal(body.code, 'PATH_OUTSIDE_PROJECT');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(statCalls, 0);
  assert.equal(readCalls, 0);
});

test('tasks and PRD listing failures do not expose filesystem diagnostics', async () => {
  const logEntries: unknown[] = [];
  const projectPath = '/srv/cloudcli/projects-ro/demo';
  const router = createTaskmasterRouter({
    fileSystem: { constants: { R_OK: 4 } } as typeof import('node:fs'),
    fileSystemPromises: {
      realpath: async (candidatePath: string) => candidatePath,
      stat: async () => ({ isFile: () => true }),
      readFile: async () => {
        throw new Error('TASK_FILE_MARKER /srv/cloudcli/private/tasks.json');
      },
      access: async () => undefined,
      readdir: async () => {
        throw new Error('PRD_FILE_MARKER /srv/cloudcli/private/docs');
      },
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => projectPath,
    logger: {
      error: (...args: unknown[]) => logEntries.push(args),
      warn: () => {},
      info: () => {},
    },
    taskmasterService: {
      detectMcpServer: async () => ({ hasMCPServer: false, reason: 'Not configured', hasConfig: false }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/taskmaster`;
    const taskResponse = await fetch(`${baseUrl}/tasks/project-1`);
    const prdResponse = await fetch(`${baseUrl}/prd/project-1`);
    assert.equal(taskResponse.status, 500);
    assert.equal(prdResponse.status, 500);
    const bodies = [await taskResponse.json(), await prdResponse.json()];
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes('TASK_FILE_MARKER'), false);
      assert.equal(serialized.includes('PRD_FILE_MARKER'), false);
      assert.equal(serialized.includes('/srv/cloudcli/private'), false);
      assert.equal((body as Record<string, unknown>).message, 'TaskMaster operation failed.');
      assert.equal((body as Record<string, unknown>).reasonCode, 'TASKMASTER_UNEXPECTED_ERROR');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(JSON.stringify(logEntries).includes('TASK_FILE_MARKER'), false);
  assert.equal(JSON.stringify(logEntries).includes('PRD_FILE_MARKER'), false);
  assert.equal(JSON.stringify(logEntries).includes('/srv/cloudcli/private'), false);
});

test('TaskMaster process errors use a stable response and never expose diagnostics', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const logEntries: unknown[] = [];

  const router = createTaskmasterRouter({
    fileSystem: { constants: { F_OK: 0 } } as typeof import('node:fs'),
    fileSystemPromises: {
      access: async () => { throw new Error('not initialized'); },
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => {
      process.nextTick(() => {
        child.stdout.write(`${'/srv/cloudcli/projects-ro/secret TASKMASTER_MARKER'.repeat(512)}`);
        child.stderr.write(`${'Authorization: Bearer TASKMASTER_MARKER'.repeat(512)}`);
        child.emit('error', new Error('spawn failed TASKMASTER_MARKER'));
        child.emit('close', 1);
      });
      return child;
    }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    logger: {
      error: (...args: unknown[]) => logEntries.push(args),
      warn: () => {},
      info: () => {},
    },
    resolveProjectPathById: () => '/workspace/project',
    taskmasterService: {
      detectMcpServer: async () => ({
        hasMCPServer: false,
        reason: 'Not configured',
        hasConfig: false,
      }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/init/project-1`, {
      method: 'POST',
    });
    assert.equal(response.status, 500);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, {
      error: 'Failed to initialize TaskMaster',
      message: 'TaskMaster operation failed.',
      reasonCode: 'TASKMASTER_PROCESS_FAILED',
      code: null,
    });
    assert.equal(JSON.stringify(body).includes('TASKMASTER_MARKER'), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(JSON.stringify(logEntries).includes('TASKMASTER_MARKER'), false);
  assert.equal(JSON.stringify(logEntries).includes('/srv/cloudcli'), false);
  const logText = JSON.stringify(logEntries);
  assert.equal(logText.includes('"stdoutBytes":8193'), true);
  assert.equal(logText.includes('"stderrBytes":8193'), true);
});

test('TaskMaster operations invoke the configured task CLI directly', async () => {
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const spawnProcess = ((command: string, args: string[], options: { cwd?: string }) => {
    spawnCalls.push({ command, args: [...args], cwd: options.cwd });
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.write('/srv/cloudcli/projects-ro/secret SUCCESS_MARKER');
      child.stderr.write('Authorization: Bearer SUCCESS_MARKER');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'];

  const router = createTaskmasterRouter({
    fileSystem: { constants: { F_OK: 0 } } as typeof import('node:fs'),
    fileSystemPromises: {
      access: async (candidatePath: string) => {
        if (candidatePath === '/workspace/project/.taskmaster') {
          throw new Error('not initialized');
        }
      },
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess,
    taskmasterCliCommand: '/opt/cloudcli-tools/bin/task-master',
    resolveProjectPathById: () => '/workspace/project',
    taskmasterService: {
      detectMcpServer: async () => ({
        hasMCPServer: false,
        reason: 'Not configured',
        hasConfig: false,
      }),
    },
  });
  const app = express().use(express.json()).use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/taskmaster`;
    const requests: Array<() => Promise<Response>> = [
      () => fetch(`${baseUrl}/init/project-1`, { method: 'POST' }),
      () => fetch(`${baseUrl}/add-task/project-1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Add a regression test' }),
      }),
      () => fetch(`${baseUrl}/update-task/project-1/7`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }),
      () => fetch(`${baseUrl}/update-task/project-1/8`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Updated title' }),
      }),
      () => fetch(`${baseUrl}/parse-prd/project-1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'brief.md', numTasks: 4 }),
      }),
    ];

    const responses: Response[] = [];
    for (const request of requests) responses.push(await request());
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
    for (const response of responses) {
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.output, null);
      assert.equal(JSON.stringify(body).includes('SUCCESS_MARKER'), false);
      assert.equal(JSON.stringify(body).includes('/srv/cloudcli'), false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.equal(spawnCalls.length, 5);
  assert.ok(spawnCalls.every(({ command }) => command === '/opt/cloudcli-tools/bin/task-master'));
  assert.deepEqual(spawnCalls.map(({ args }) => args), [
    ['init', '-y'],
    ['add-task', '--prompt', 'Add a regression test', '--research', '--priority', 'medium'],
    ['set-status', '--id=7', '--status=done'],
    ['update-task', '--id=8', '--prompt=Update task with the following changes: title: "Updated title"'],
    ['parse-prd', '--input', '/workspace/project/.taskmaster/docs/brief.md', '--num-tasks', '4', '--research'],
  ]);
  assert.ok(spawnCalls.every(({ args }) => !args.includes('task-master-ai')));
});

test('TaskMaster broadcasts reach only the tracked chat clients', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const chatClient = { readyState: 1, frames: [] as string[], send(data: string) { this.frames.push(data); } };
  const closingClient = { readyState: 3, frames: [] as string[], send(data: string) { this.frames.push(data); } };

  const router = createTaskmasterRouter({
    fileSystem: { constants: { F_OK: 0 } } as typeof import('node:fs'),
    fileSystemPromises: {
      access: async () => { throw new Error('not initialized'); },
    } as unknown as typeof import('node:fs/promises'),
    spawnProcess: (() => {
      process.nextTick(() => child.emit('close', 0));
      return child;
    }) as unknown as Parameters<typeof createTaskmasterRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => '/workspace/project',
    taskmasterService: {
      detectMcpServer: async () => ({
        hasMCPServer: false,
        reason: 'Not configured',
        hasConfig: false,
      }),
    },
  });
  const app = express().use('/api/taskmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  connectedClients.add(chatClient as never);
  connectedClients.add(closingClient as never);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/taskmaster/init/project-1`, {
      method: 'POST',
    });
    assert.equal(response.status, 200);

    assert.equal(chatClient.frames.length, 1);
    const frame = JSON.parse(chatClient.frames[0]) as Record<string, unknown>;
    assert.equal(frame.type, 'taskmaster-project-updated');
    assert.equal(frame.projectId, 'project-1');
    assert.equal(closingClient.frames.length, 0);
  } finally {
    connectedClients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
