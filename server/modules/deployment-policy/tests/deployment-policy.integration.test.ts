import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createGitRouter } from '@/modules/git/git.routes.js';
import type { FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  createDeploymentPolicyMiddleware,
  DEPLOYMENT_CAPABILITIES,
  parseDeploymentPolicy,
  resolveCanonicalPath,
} from '../index.js';

/**
 * Build the policy used by the 0.78 product/QA deployment in every test.
 * Keeping the policy explicit prevents the test process' ambient environment
 * from changing the authorization result.
 */
function readonlyPolicy() {
  return parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
}

function capabilityGuard(): (operation: string) => RequestHandler {
  const policy = readonlyPolicy();
  return (operation) => createDeploymentPolicyMiddleware({
    policy,
    capability: operation,
  });
}

function appErrorMiddleware(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
    return;
  }
  response.status(500).json({ error: 'INTERNAL_ERROR' });
}

async function withServer(
  router: express.Router,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(appErrorMiddleware);
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

function createGitTestRouter(
  spawnProcess: Parameters<typeof createGitRouter>[0]['spawnProcess'],
) {
  const unexpectedProvider = async (): Promise<never> => {
    throw new Error('Provider must not run for a denied request');
  };

  return createGitRouter({
    isProtectedBaselinePath: () => false,
    fileSystem: { access: async () => undefined } as unknown as
      Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess,
    resolveProjectPathById: () => '/workspace/repository',
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
    capabilityGuard: capabilityGuard(),
  });
}

test('an unknown explicit deployment profile fails closed during startup parsing', () => {
  assert.throws(
    () => parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly-typo',
    }),
    (error: unknown) => error instanceof AppError
      && error.code === 'INVALID_DEPLOYMENT_PROFILE'
      && error.statusCode >= 400,
  );
});

test('read-only profile cannot be reopened by capability environment overrides', () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: [
      'repo.write=true',
      'file.write=true',
      'git.fetch=true',
      'git.write=true',
      'browser-use=true',
      'shell-execute=true',
      'terminal.interactive=true',
      'agent.use=true',
    ].join(','),
  });

  for (const capability of [
    DEPLOYMENT_CAPABILITIES.REPO_WRITE,
    DEPLOYMENT_CAPABILITIES.FILE_WRITE,
    DEPLOYMENT_CAPABILITIES.GIT_FETCH,
    DEPLOYMENT_CAPABILITIES.GIT_WRITE,
    DEPLOYMENT_CAPABILITIES.BROWSER_USE,
    DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE,
    DEPLOYMENT_CAPABILITIES.TERMINAL_INTERACTIVE,
    DEPLOYMENT_CAPABILITIES.AGENT_USE,
  ]) {
    assert.equal(policy.capabilities[capability], false, capability);
  }
});

test('read-only Git policy rejects fetch before any repository command runs', async () => {
  let spawnCalls = 0;
  const spawnProcess = (() => {
    spawnCalls += 1;
    throw new Error('Git must not run for a denied fetch');
  }) as Parameters<typeof createGitRouter>[0]['spawnProcess'];

  const appRouter = express.Router();
  appRouter.use('/api/git', createGitTestRouter(spawnProcess));

  await withServer(appRouter, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/git/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1' }),
    });
    const payload = await response.json() as { code?: string };

    assert.equal(response.status, 403);
    assert.equal(payload.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  });

  assert.equal(spawnCalls, 0);
});

test('read-only File Tree policy rejects writes and uploads before handlers run', async () => {
  let saveCalls = 0;
  let uploadCalls = 0;
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('File Tree service must not run for a denied mutation');
  };
  const services: FileTreeServices = {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: async () => {
      saveCalls += 1;
      throw new Error('saveTextFile must not run');
    },
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: async () => {
      uploadCalls += 1;
      throw new Error('storeUploadedFiles must not run');
    },
  };
  const uploadMiddleware: RequestHandler = (_request, _response, next) => {
    uploadCalls += 1;
    next();
  };
  const router = express.Router();
  router.use('/api/file-tree', createFileTreeRouter(
    services,
    uploadMiddleware,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
    capabilityGuard(),
  ));

  await withServer(router, async (baseUrl) => {
    const writeResponse = await fetch(`${baseUrl}/api/file-tree/projects/project-1/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'README.md', content: 'attempted mutation' }),
    });
    const uploadResponse = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/upload`, {
      method: 'POST',
    });

    assert.equal(writeResponse.status, 403);
    assert.equal(uploadResponse.status, 403);
    assert.equal((await writeResponse.json() as { code?: string }).code, 'DEPLOYMENT_CAPABILITY_DENIED');
    assert.equal((await uploadResponse.json() as { code?: string }).code, 'DEPLOYMENT_CAPABILITY_DENIED');
  });

  assert.equal(saveCalls, 0);
  // The router-level guard must run before multer/upload middleware. This is
  // important because rejected multipart requests otherwise leave temp files.
  assert.equal(uploadCalls, 0);
});

test('canonical path policy rejects a symlink that escapes the permitted root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deployment-policy-integration-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'must not be reachable');
  await symlink(outside, path.join(allowed, 'escape'), 'dir');

  await assert.rejects(
    resolveCanonicalPath(path.join(allowed, 'escape', 'secret.txt'), { beneath: allowed }),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_CANONICAL_ROOT'
      && error.statusCode === 403,
  );
});

test('middleware propagates a symlink escape as a denied HTTP request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deployment-policy-middleware-'));
  const outside = path.join(root, 'outside');
  const allowed = path.join(root, 'allowed');
  await mkdir(outside);
  await mkdir(allowed);
  await writeFile(path.join(outside, 'secret.txt'), 'nope');
  await symlink(outside, path.join(allowed, 'escape'), 'dir');

  let handlerCalls = 0;
  const router = express.Router();
  router.post(
    '/mutate',
    createDeploymentPolicyMiddleware({
      policy: readonlyPolicy(),
      // Capability denial is checked before the path check, so use a read
      // capability here to exercise the canonical path branch itself.
      capability: DEPLOYMENT_CAPABILITIES.REPO_READ,
      targetPath: (request) => request.body?.targetPath,
      pathRoot: allowed,
    }),
    (_request, response) => {
      handlerCalls += 1;
      response.json({ ok: true });
    },
  );

  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetPath: path.join(allowed, 'escape', 'secret.txt') }),
    });
    const payload = await response.json() as { code?: string };
    assert.equal(response.status, 403);
    assert.equal(payload.code, 'PATH_OUTSIDE_CANONICAL_ROOT');
  });

  assert.equal(handlerCalls, 0);
});
