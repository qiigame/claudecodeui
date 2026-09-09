import assert from 'node:assert/strict';
import test from 'node:test';

import type { Request, RequestHandler, Response } from 'express';

import type { CollaborationActorSummary } from '@/shared/types.js';

import {
  assertNoRawGithubTokenOnGet,
  createForceProjectDeleteGuard,
  createProjectWriteCapabilityGuard,
  createVerifiedProjectActorGuard,
  isCloneProgressClientClosed,
  PROJECT_WRITE_CAPABILITIES,
  shouldExposeTaskMasterProjectPath,
  shouldSkipProjectSynchronization,
} from '../projects.routes.js';
import {
  createDeploymentPolicyGuard,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';

const requestFor = (userId: number): Request => ({
  user: {
    id: userId,
    actor: {
      provider: 'dingtalk',
    },
  },
} as unknown as Request);

const actorFor = (
  identityStatus: CollaborationActorSummary['identityStatus'],
): CollaborationActorSummary => ({
  actorId: 11,
  userId: 7,
  displayName: '待登记用户',
  badge: '待',
  provider: 'dingtalk',
  providerName: 'DingTalk',
  personId: identityStatus === 'verified' ? 'person-7' : null,
  identityStatus,
});

function runGuard(
  guard: RequestHandler,
  request: Partial<Request> = {},
): unknown {
  let nextError: unknown;
  guard(
    {
      method: 'POST',
      query: {},
      body: {},
      ...request,
    } as Request,
    {} as Response,
    (error?: unknown) => {
      nextError = error;
    },
  );
  return nextError;
}

function assertCapabilityDenied(error: unknown): void {
  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.equal((error as { statusCode?: number }).statusCode, 403);
}

test('project creation and clone capability matrices stay explicit', () => {
  assert.deepEqual(PROJECT_WRITE_CAPABILITIES.create, [
    'file.write',
    'repo.write',
  ]);
  assert.deepEqual(PROJECT_WRITE_CAPABILITIES.clone, [
    'file.write',
    'repo.write',
    'git.fetch',
  ]);
  assert.deepEqual(PROJECT_WRITE_CAPABILITIES.forceDelete, ['file.write']);

  const developerPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });
  for (const operation of ['create', 'clone', 'forceDelete'] as const) {
    assert.equal(runGuard(createProjectWriteCapabilityGuard(operation, developerPolicy)), undefined);
  }
});

test('project create and clone guards deny a project.mutate-only custom policy', () => {
  const createMissingCapabilities = [
    'file.write',
    'repo.write',
  ] as const;
  for (const missingCapability of createMissingCapabilities) {
    const policy = parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
      CLOUDCLI_DEPLOYMENT_CAPABILITIES: `${missingCapability}=false`,
    });
    assertCapabilityDenied(runGuard(createProjectWriteCapabilityGuard('create', policy)));
  }

  const cloneMissingCapabilities = [
    'file.write',
    'repo.write',
    'git.fetch',
  ] as const;
  for (const missingCapability of cloneMissingCapabilities) {
    const policy = parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
      CLOUDCLI_DEPLOYMENT_CAPABILITIES: `${missingCapability}=false`,
    });
    assertCapabilityDenied(runGuard(createProjectWriteCapabilityGuard('clone', policy)));
  }
});

test('force project deletion requires file.write while soft archive remains compatible', () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'file.write=false',
  });
  const guard = createForceProjectDeleteGuard(policy);

  assert.equal(runGuard(guard, { query: { force: 'false' } }), undefined);
  assert.equal(runGuard(guard, { query: { force: '0' } }), undefined);
  assertCapabilityDenied(runGuard(guard, { query: { force: 'true' } }));
});

test('project side-effect guards still honor the deployment policy attached to a request', () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'repo.write=false',
  });
  const request = {
    method: 'POST',
    query: {},
    body: {},
    deploymentPolicy: policy,
  } as unknown as Request;
  const guard = createProjectWriteCapabilityGuard('create');
  assertCapabilityDenied(runGuard(guard, request));

  // A separately composed project.mutate guard remains required by the route;
  // this test documents that the narrow guard does not silently grant it.
  const projectMutationGuard = createDeploymentPolicyGuard({
    capability: 'project.mutate',
  });
  assert.equal(runGuard(projectMutationGuard, request), undefined);
});

test('TaskMaster project path visibility follows readonly and managed actor policy', () => {
  const readonlyPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  const developerPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });

  assert.equal(
    shouldExposeTaskMasterProjectPath({ deploymentPolicy: readonlyPolicy } as unknown as Request),
    false,
  );
  assert.equal(
    shouldExposeTaskMasterProjectPath({
      deploymentPolicy: developerPolicy,
      user: {
        actor: { provider: 'dingtalk' },
        permissions: { manageSettings: false },
      },
    } as unknown as Request),
    false,
  );
  assert.equal(
    shouldExposeTaskMasterProjectPath({
      deploymentPolicy: developerPolicy,
      user: { id: 7 },
    } as unknown as Request),
    true,
  );
  assert.equal(
    shouldExposeTaskMasterProjectPath({
      deploymentPolicy: developerPolicy,
      user: {
        actor: { provider: 'dingtalk' },
        permissions: { manageSettings: true },
      },
    } as unknown as Request),
    true,
  );
});

test('clone-progress guard blocks pending and ambiguous DingTalk actors before the handler', () => {
  for (const identityStatus of ['pending', 'ambiguous'] as const) {
    let nextCalls = 0;
    let cloneStarted = false;
    const guard = createVerifiedProjectActorGuard({
      requiresDingTalk: true,
      getActorByUserId: () => actorFor(identityStatus),
      assertActorCanWrite: () => {
        throw new Error('pending actors must not reach the write assertion');
      },
    });

    guard(requestFor(7), {} as Response, (error?: unknown) => {
      nextCalls += 1;
      if (!error) cloneStarted = true;
      assert.equal((error as { code?: string } | undefined)?.code, 'IDENTITY_ENROLLMENT_REQUIRED');
    });

    assert.equal(nextCalls, 1, identityStatus);
    assert.equal(cloneStarted, false, identityStatus);
  }
});

test('clone-progress guard revalidates a verified actor immediately before cloning', () => {
  let assertedUserId: string | number | null | undefined = null;
  let nextCalls = 0;
  const guard = createVerifiedProjectActorGuard({
    requiresDingTalk: true,
    getActorByUserId: () => actorFor('verified'),
    assertActorCanWrite: (userId) => {
      assertedUserId = userId;
    },
  });

  guard(requestFor(7), {} as Response, (error?: unknown) => {
    assert.equal(error, undefined);
    nextCalls += 1;
  });

  assert.equal(assertedUserId, 7);
  assert.equal(nextCalls, 1);
});

test('local clone-progress requests remain compatible when DingTalk is not required', () => {
  let actorLookups = 0;
  let nextCalls = 0;
  const guard = createVerifiedProjectActorGuard({
    requiresDingTalk: false,
    getActorByUserId: () => {
      actorLookups += 1;
      return actorFor('pending');
    },
    assertActorCanWrite: () => {
      throw new Error('local password sessions should not require a DingTalk actor');
    },
  });

  guard({
    user: {
      id: 7,
      // A stale actor association from an earlier SSO setup must not narrow
      // the explicit local developer profile.
      actor: { provider: 'dingtalk', identityStatus: 'pending' },
    },
  } as unknown as Request, {} as Response, (error?: unknown) => {
    assert.equal(error, undefined);
    nextCalls += 1;
  });

  assert.equal(actorLookups, 0);
  assert.equal(nextCalls, 1);
});

test('clone-progress rejects raw GitHub tokens on legacy GET transport', () => {
  for (const key of [
    'newGithubToken',
    'githubToken',
    'rawGithubToken',
    'github_token',
    'github-token',
    'access_token',
    'accessToken',
  ]) {
    assert.throws(
      () => assertNoRawGithubTokenOnGet('GET', { [key]: 'secret-token' }),
      (error: unknown) => (
        error instanceof Error
        && (error as { code?: string }).code === 'CLONE_TOKEN_QUERY_NOT_ALLOWED'
        && (error as { statusCode?: number }).statusCode === 400
        && !error.message.includes('secret-token')
      ),
      key,
    );
  }
});

test('clone-progress keeps token-free GET and all POST payloads compatible', () => {
  assert.doesNotThrow(() => assertNoRawGithubTokenOnGet('GET', {
    path: '/workspace',
    githubUrl: 'https://github.com/example/repo.git',
    githubTokenId: '12',
  }));
  assert.doesNotThrow(() => assertNoRawGithubTokenOnGet('POST', {
    newGithubToken: 'secret-token',
  }));
});

test('clone-progress rejects raw GitHub tokens in any repeated GET query value', () => {
  assert.throws(
    () => assertNoRawGithubTokenOnGet('GET', {
      githubToken: ['', 'secret-token'],
    }),
    (error: unknown) => (
      error instanceof Error
      && (error as { code?: string }).code === 'CLONE_TOKEN_QUERY_NOT_ALLOWED'
      && (error as { statusCode?: number }).statusCode === 400
      && !error.message.includes('secret-token')
    ),
  );
});

test('clone-progress cancellation follows the SSE response, not a completed request stream', () => {
  // Node marks IncomingMessage.destroyed=true after a normal request body has
  // been consumed. That state must not cancel an otherwise-live SSE response.
  assert.equal(isCloneProgressClientClosed(false, {
    writableEnded: false,
    destroyed: false,
  }), false);

  // A response destroyed before it is ended is the actual disconnect signal.
  assert.equal(isCloneProgressClientClosed(false, {
    writableEnded: false,
    destroyed: true,
  }), true);

  // Normal server completion also emits response close, but writableEnded
  // keeps it from being mistaken for a client abort.
  assert.equal(isCloneProgressClientClosed(false, {
    writableEnded: true,
    destroyed: true,
  }), false);

  // An explicit abort observed while the request body is in flight remains a
  // cancellation even before the response has been destroyed.
  assert.equal(isCloneProgressClientClosed(true, {
    writableEnded: false,
    destroyed: false,
  }), true);
});

test('product/QA read-only project GETs skip provider synchronization even with session.write', () => {
  const request = {
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  } as unknown as Request;

  assert.equal(shouldSkipProjectSynchronization(request), true);
});

test('custom policies skip provider synchronization when session.write is denied', () => {
  const request = {
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
      CLOUDCLI_CAPABILITY_SESSION_WRITE: 'false',
    }),
  } as unknown as Request;

  assert.equal(shouldSkipProjectSynchronization(request), true);
});

test('project GETs retain synchronization when session.write is granted', () => {
  const request = {
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
      CLOUDCLI_CAPABILITY_SESSION_WRITE: 'true',
    }),
  } as unknown as Request;

  assert.equal(shouldSkipProjectSynchronization(request), false);
});

test('a writable developer policy keeps the provider synchronization path enabled', () => {
  const request = {
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    }),
  } as unknown as Request;

  assert.equal(shouldSkipProjectSynchronization(request), false);
});
