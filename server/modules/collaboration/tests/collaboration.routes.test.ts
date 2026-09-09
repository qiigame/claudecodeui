import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import {
  createCollaborationRoutes,
  createPublicShareRoutes,
} from '@/modules/collaboration/collaboration.routes.js';
import { collaborationService } from '@/modules/collaboration/collaboration.service.js';
import { executionAttributionService } from '@/modules/collaboration/execution-attribution.service.js';
import { createDeploymentPolicyMiddleware, parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

test('public share route is unauthenticated and sends privacy headers', async () => {
  const app = express();
  app.use('/api/public/shares', createPublicShareRoutes({
    getProjectGuide: async () => ({ projectId: '', projectName: '', documents: [] }),
    sessionShares: {
      create: async () => ({ shareId: '', token: '', path: '', expiresAt: '' }),
      listActiveForSession: () => [],
      revoke: (shareId) => ({ shareId, revoked: true }),
      getPublic: () => ({
        expiresAt: '2026-09-02T00:00:00.000Z',
        snapshot: {
          version: 1,
          title: 'Shared session',
          provider: 'codex' as LLMProvider,
          projectName: 'Comic App',
          createdAt: null,
          sharedAt: '2026-09-01T00:00:00.000Z',
          messages: [],
          isTruncated: false,
        },
      }),
    },
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    response.status(status).json({ error: 'failed' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/public/shares/${'a'.repeat(43)}`,
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('authenticated share list is scoped to the current user and session', async () => {
  const calls: Array<{ sessionId: string; createdByUserId: number }> = [];
  const app = express();
  app.use((request, _response, next) => {
    (request as Request & { user: { id: number } }).user = { id: 42 };
    next();
  });
  app.use('/api/collaboration', createCollaborationRoutes({
    actors: collaborationService,
    executionAttribution: executionAttributionService,
    getProjectGuide: async () => ({ projectId: '', projectName: '', documents: [] }),
    sessionShares: {
      create: async () => ({ shareId: '', token: '', path: '', expiresAt: '' }),
      listActiveForSession: (input) => {
        calls.push(input);
        return [{ shareId: 'share-1', expiresAt: '2026-09-02T00:00:00.000Z' }];
      },
      revoke: (shareId) => ({ shareId, revoked: true }),
      getPublic: () => {
        throw new Error('not used');
      },
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/collaboration/sessions/session-1/shares`,
    );
    const payload = await response.json() as {
      data: { sessionId: string; shares: Array<{ shareId: string }> };
    };

    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(calls, [{ sessionId: 'session-1', createdByUserId: 42 }]);
    assert.equal(payload.data.sessionId, 'session-1');
    assert.deepEqual(payload.data.shares, [{
      shareId: 'share-1',
      expiresAt: '2026-09-02T00:00:00.000Z',
    }]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('identity enrollment subjects are restricted to settings admins', async () => {
  const enrollments = [{
    actorId: 3,
    userId: 7,
    displayName: '待登记成员',
    providerKey: 'haohan',
    providerName: '灏瀚',
    externalSubject: 'union-pending',
    subjectScope: 'global' as const,
    identityStatus: 'pending' as const,
    createdAt: '2026-09-04T00:00:00Z',
    lastLoginAt: '2026-09-04T00:00:00Z',
  }];
  const actors = {
    ...collaborationService,
    listPendingIdentityEnrollments: () => enrollments,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/collaboration', (request, _response, next) => {
    (request as Request & { user: unknown }).user = {
      id: 7,
      permissions: { manageSettings: true },
      actor: {
        userId: 7,
        provider: 'dingtalk',
        personId: 'zhaojingyu',
        identityStatus: 'verified',
      },
    };
    next();
  }, createCollaborationRoutes({
    actors,
    executionAttribution: executionAttributionService,
    getProjectGuide: async () => ({ projectId: '', projectName: '', documents: [] }),
    sessionShares: {
      create: async () => ({ shareId: '', token: '', path: '', expiresAt: '' }),
      listActiveForSession: () => [],
      revoke: (shareId) => ({ shareId, revoked: true }),
      getPublic: () => { throw new Error('not used'); },
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/collaboration/identity-enrollments`);
    const payload = await response.json() as { data: { enrollments: typeof enrollments } };
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.deepEqual(payload.data.enrollments, enrollments);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('identity enrollment endpoint denies ordinary authenticated members', async () => {
  const app = express();
  app.use('/api/collaboration', (request, _response, next) => {
    (request as Request & { user: unknown }).user = {
      id: 8,
      permissions: { manageSettings: false },
      actor: {
        userId: 8,
        provider: 'dingtalk',
        personId: 'zhaojingyu',
        identityStatus: 'verified',
      },
    };
    next();
  }, createCollaborationRoutes({
    actors: {
      ...collaborationService,
      listPendingIdentityEnrollments: () => [],
    },
    executionAttribution: executionAttributionService,
    getProjectGuide: async () => ({ projectId: '', projectName: '', documents: [] }),
    sessionShares: {
      create: async () => ({ shareId: '', token: '', path: '', expiresAt: '' }),
      listActiveForSession: () => [],
      revoke: (shareId) => ({ shareId, revoked: true }),
      getPublic: () => { throw new Error('not used'); },
    },
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    response.status(status).json({ error: error instanceof Error ? error.message : 'failed' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/collaboration/identity-enrollments`);
    assert.equal(response.status, 403);
    const payload = await response.json() as { error: string };
    assert.equal(payload.error, 'Identity enrollment access is denied.');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('deployment without session.write denies share creation before snapshot work starts', async () => {
  let createCalls = 0;
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'session.write=false',
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as Request & { user: { id: number } }).user = { id: 42 };
    next();
  });
  app.use('/api/collaboration', createCollaborationRoutes({
    actors: collaborationService,
    executionAttribution: executionAttributionService,
    getProjectGuide: async () => ({ projectId: '', projectName: '', documents: [] }),
    sessionShares: {
      create: async () => {
        createCalls += 1;
        throw new Error('share snapshot must not be created');
      },
      listActiveForSession: () => [],
      revoke: (shareId) => ({ shareId, revoked: true }),
      getPublic: () => { throw new Error('not used'); },
    },
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/collaboration/sessions/session-1/shares`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(createCalls, 0);
});

test('deployment without session.write denies share revocation before persistence', async () => {
  let revokeCalls = 0;
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'session.write=false',
  });
  const app = express();
  app.use((request, _response, next) => {
    (request as Request & { user: { id: number } }).user = { id: 42 };
    next();
  });
  app.use('/api/collaboration', createCollaborationRoutes({
    actors: collaborationService,
    executionAttribution: executionAttributionService,
    getProjectGuide: async () => ({ projectId: '', projectName: '', documents: [] }),
    sessionShares: {
      create: async () => ({ shareId: '', token: '', path: '', expiresAt: '' }),
      listActiveForSession: () => [],
      revoke: (shareId) => {
        revokeCalls += 1;
        return { shareId, revoked: true };
      },
      getPublic: () => { throw new Error('not used'); },
    },
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/collaboration/shares/share-1`,
      { method: 'DELETE' },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(revokeCalls, 0);
});
