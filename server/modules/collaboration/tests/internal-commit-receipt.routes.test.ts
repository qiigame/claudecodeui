import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import {
  createInternalCommitReceiptRoutes,
} from '@/modules/collaboration/collaboration.routes.js';
import type { executionAttributionService } from '@/modules/collaboration/execution-attribution.service.js';
import {
  createDeploymentPolicyMiddleware,
  DEPLOYMENT_CAPABILITIES,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * The receipt endpoint is a loopback service-to-service bridge.  It must not
 * interpret an arbitrary Authorization value (or a duplicate header) as a
 * token, and malformed input should be a stable 401 rather than a TypeError
 * 500 that leaks implementation details.
 */
test('internal commit receipt bridge uses strict bearer credentials', async () => {
  let recordCalls = 0;
  const service = {
    recordCommitReceipt: async () => {
      recordCalls += 1;
      return {
        commitSha: 'a'.repeat(40),
        repoPath: '/tmp/repo',
        runId: 'run-1',
        sessionId: null,
        humanActor: null,
        taskId: null,
        provider: 'codex',
        authorName: 'Agent',
        authorEmail: 'agent@example.com',
        committerName: 'Agent',
        committerEmail: 'agent@example.com',
        verificationStatus: 'verified',
        committedAt: '2026-09-04T00:00:00.000Z',
        actor: {
          actorId: 1,
          userId: 1,
          provider: 'dingtalk',
          providerKey: 'test',
          providerName: 'Test',
          externalSubject: 'subject',
          subjectScope: 'global',
          displayName: 'Agent',
          badge: 'A',
          personId: 'person-1',
          identityStatus: 'verified',
          gitName: 'Agent',
          gitEmail: 'agent@example.com',
          gitIdentityMode: 'personal',
          createdAt: '2026-09-04T00:00:00.000Z',
          lastLoginAt: '2026-09-04T00:00:00.000Z',
        },
      };
    },
  } as unknown as typeof executionAttributionService;

  const app = express();
  app.use(express.json());
  app.use('/api/internal/commit-receipts', createInternalCommitReceiptRoutes(service));
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
    const endpoint = `http://127.0.0.1:${address.port}/api/internal/commit-receipts`;
    const body = JSON.stringify({
      runId: 'run-1',
      repoPath: '/tmp/repo',
      commitSha: 'a'.repeat(40),
    });

    for (const authorization of [
      'Basic not-a-bearer-token',
      'Bearer token with-extra-data',
      'Bearer token,second-token',
    ]) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body,
      });
      assert.equal(response.status, 401, authorization);
      assert.deepEqual(await response.json(), { code: 'COMMIT_RECEIPT_TOKEN_REQUIRED' });
    }

    const valid = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer execution-token',
        'content-type': 'application/json',
      },
      body,
    });
    assert.equal(valid.status, 201);
    assert.equal(recordCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('read-only deployment rejects commit receipts before the service is called', async () => {
  let recordCalls = 0;
  const service = {
    recordCommitReceipt: async () => {
      recordCalls += 1;
      throw new Error('receipt service must not run');
    },
  } as unknown as typeof executionAttributionService;
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/internal/commit-receipts',
    createDeploymentPolicyMiddleware({
      policy,
      capability: DEPLOYMENT_CAPABILITIES.GIT_WRITE,
    }),
    createInternalCommitReceiptRoutes(service),
  );
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
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/internal/commit-receipts`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer execution-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runId: 'run-1',
          repoPath: '/tmp/repo',
          commitSha: 'a'.repeat(40),
        }),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
    assert.equal(recordCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
