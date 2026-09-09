import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import {
  createDeploymentPolicyMiddleware,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { AppError } from '@/shared/utils.js';

import {
  assetUploadErrorResponse,
  createAssetsRouter,
} from '../assets.routes.js';

test('asset upload error mapping never returns storage paths or raw errors', () => {
  const mapped = assetUploadErrorResponse(
    new Error('EACCES: cannot write /Users/service/.cloudcli/assets/tmp-file'),
    10,
  );

  assert.deepEqual(mapped, {
    statusCode: 500,
    message: 'Upload failed.',
  });
  assert.equal(mapped.message.includes('/Users/service/.cloudcli'), false);
});

test('asset upload error mapping keeps safe Multer diagnostics', () => {
  assert.deepEqual(
    assetUploadErrorResponse(Object.assign(new Error('too large'), { code: 'LIMIT_FILE_SIZE' }), 5),
    { statusCode: 400, message: 'File too large. Maximum size is 50MB.' },
  );
  assert.deepEqual(
    assetUploadErrorResponse(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'), 5),
    { statusCode: 400, message: 'Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.' },
  );
});

async function withAssetsServer(
  router: express.Router,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/assets', router);
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({
      code: appError?.code ?? 'INTERNAL_ERROR',
    });
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

test('asset GET routes require file.read before opening an asset', async () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'file.read=false',
  });
  const operations: string[] = [];
  const router = createAssetsRouter((operation) => {
    operations.push(operation);
    return createDeploymentPolicyMiddleware({ policy, capability: operation });
  });

  await withAssetsServer(router, async (baseUrl) => {
    for (const path of [
      '/api/assets/images/asset-that-does-not-exist.png',
      '/api/assets/files/asset-that-does-not-exist.pdf',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
    }
  });

  // The denied middleware runs before the route callback, so neither request
  // reaches openStoredAttachmentAsset (which would otherwise return 404).
  assert.deepEqual(operations, [
    'attachment.upload',
    'file.read',
  ]);
});

test('standalone asset router enforces its captured file.read policy', async () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'file.read=false',
  });
  const router = createAssetsRouter(undefined, { deploymentPolicy: policy });

  await withAssetsServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/assets/files/asset-that-does-not-exist.txt`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
  });
});
