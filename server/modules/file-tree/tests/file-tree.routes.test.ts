import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
  capabilityGuard?: (operation: string) => RequestHandler,
  uploadFilesMiddleware: RequestHandler = passUploadRequest,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    uploadFilesMiddleware,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
    capabilityGuard,
  ));

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

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('File Tree read routes require the dedicated file.read capability', async () => {
  const operations: string[] = [];
  const services = createFakeServices({
    listProjectFiles: async () => [],
  });

  await withFileTreeServer(
    services,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);
      assert.equal(response.status, 200);
    },
    (operation) => (_request, _response, next) => {
      operations.push(operation);
      next();
    },
  );

  assert.deepEqual(operations, ['file.read']);
});

test('File Tree read denial happens before the service is called', async () => {
  let listCalled = false;
  const services = createFakeServices({
    listProjectFiles: async () => {
      listCalled = true;
      return [];
    },
  });

  await withFileTreeServer(
    services,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'file reads disabled' });
    },
    (operation) => (_request, response, next) => {
      if (operation === 'file.read') {
        response.status(403).json({ error: 'file reads disabled' });
        return;
      }
      next();
    },
  );

  assert.equal(listCalled, false);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('project files route forwards an explicitly requested lazy directory', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const requestedDirectory = '/workspace/project/first repository';
    const requestUrl = new URL(`${baseUrl}/api/file-tree/projects/project-1/files`);
    requestUrl.searchParams.set('respectGitignore', 'true');
    requestUrl.searchParams.set('directoryPath', requestedDirectory);
    const response = await fetch(requestUrl);

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', {
    respectGitignore: true,
    directoryPath: '/workspace/project/first repository',
  }]]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

test('File Tree mutations require the dedicated file.write capability', async () => {
  const operations: string[] = [];
  const services = createFakeServices({
    saveTextFile: async () => ({
      success: true,
      path: '/workspace/project/README.md',
      message: 'File saved successfully',
    }),
  });

  await withFileTreeServer(
    services,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filePath: 'README.md', content: 'updated' }),
      });
      assert.equal(response.status, 200);
    },
    (operation) => (_request, _response, next) => {
      operations.push(operation);
      next();
    },
  );

  assert.deepEqual(operations, ['file.write']);
});

test('filesystem browsing requires the explicit local-filesystem capability', async () => {
  let browseCalled = false;
  const services = createFakeServices({
    browseWorkspace: async () => {
      browseCalled = true;
      return { path: '/Users/service', suggestions: [] };
    },
  });

  await withFileTreeServer(
    services,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/browse-filesystem?path=~`);
      assert.equal(response.status, 403);
    },
    (operation) => (_request, response, next) => {
      if (operation === 'file.read') {
        next();
        return;
      }
      assert.equal(operation, 'local-filesystem');
      response.status(403).json({ error: 'filesystem browsing disabled' });
      // Deliberately do not call next: the service must never receive the
      // broad HOME-directory browse request after the capability is denied.
    },
  );

  assert.equal(browseCalled, false);
});

test('File Tree upload parser errors do not expose local paths', async () => {
  const services = createFakeServices();
  const uploadError = new Error('ENOENT: cannot open /private/secret/upload.tmp');

  await withFileTreeServer(
    services,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/upload`, {
        method: 'POST',
      });
      assert.equal(response.status, 500);
      const payload = await response.json() as { error: string };
      assert.equal(payload.error, 'Upload failed.');
      assert.equal(payload.error.includes('/private/secret'), false);
    },
    (operation) => (_request, _response, next) => {
      assert.equal(operation, 'file.write');
      next();
    },
    (_request, _response, next) => next(uploadError),
  );
});

test('File Tree service errors do not expose dynamic workspace paths', async () => {
  const services = createFakeServices({
    listProjectFiles: async () => {
      throw new AppError(
        'Workspace validation failed for /Users/service/secret-project',
        { code: 'INVALID_WORKSPACE_PATH', statusCode: 403 },
      );
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 403);
    assert.equal(payload.error, 'Path is outside the workspace root');
    assert.equal(payload.error.includes('/Users/service/secret-project'), false);
  });
});

test('Unknown File Tree failures use a stable public error message', async () => {
  const services = createFakeServices({
    listProjectFiles: async () => {
      throw new Error('EIO: read failed at /Users/service/secret-project/.env');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.equal(payload.error, 'File Tree request failed.');
    assert.equal(payload.error.includes('/Users/service/secret-project'), false);
  });
});
