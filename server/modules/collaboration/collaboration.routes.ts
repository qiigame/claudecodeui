import os from 'node:os';

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  AppError,
  asyncHandler,
  createApiSuccessResponse,
  readAuthenticatedHttpUserId,
} from '@/shared/utils.js';
import { extractBearerToken } from '@/shared/bearer-token.js';
import {
  createDeploymentPolicyGuard,
  parseDeploymentPolicy,
  type DeploymentPolicy,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';

import type { collaborationService } from './collaboration.service.js';
import { executionAttributionService } from './execution-attribution.service.js';
import { getProjectGuide } from './project-guide.service.js';
import { sessionShareService } from './session-share.service.js';

type ActorService = typeof collaborationService;
type ExecutionAttributionService = typeof executionAttributionService;

type ShareGuideServices = {
  getProjectGuide: typeof getProjectGuide;
  sessionShares: typeof sessionShareService;
};

type PrivateCollaborationServices = ShareGuideServices & {
  actors: ActorService;
  executionAttribution: ExecutionAttributionService;
  /** Optional deployment capability factory supplied by the composition root. */
  capabilityGuard?: (operation: string) => RequestHandler;
  /** Startup policy used by standalone mounts when no guard is injected. */
  deploymentPolicy?: DeploymentPolicySource;
};

const DEFAULT_SHARE_GUIDE_SERVICES: ShareGuideServices = {
  getProjectGuide,
  sessionShares: sessionShareService,
};

function readPathValue(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 256) {
    throw new AppError(`${name} is required.`, {
      code: 'INVALID_PATH_PARAMETER',
      statusCode: 400,
    });
  }
  return normalized;
}

function readExpiryHours(body: unknown): number | undefined {
  if (!body || typeof body !== 'object' || !('expiresInHours' in body)) {
    return undefined;
  }
  const value = (body as { expiresInHours?: unknown }).expiresInHours;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw new AppError('expiresInHours must be a number.', {
      code: 'INVALID_SHARE_EXPIRY',
      statusCode: 400,
    });
  }
  return value;
}

function readOptionalQueryValue(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function assertEnrollmentAdmin(request: Request): void {
  const user = (request as Request & {
    user?: {
      permissions?: { manageSettings?: unknown };
      actor?: { userId?: unknown; provider?: unknown; personId?: unknown; identityStatus?: unknown };
    };
  }).user;
  const userId = user && typeof user === 'object' && 'id' in user
    ? (user as { id?: unknown }).id
    : undefined;
  if (user?.permissions?.manageSettings !== true
    || user.actor?.userId !== userId
    || user.actor?.provider !== 'dingtalk'
    || typeof user.actor.personId !== 'string'
    || user.actor.personId.trim() === ''
    || user.actor.identityStatus !== 'verified') {
    throw new AppError('Identity enrollment access is denied.', {
      code: 'IDENTITY_ENROLLMENT_ACCESS_DENIED',
      statusCode: 403,
    });
  }
}

function readReceiptLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '100'), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100;
}

function readBodyString(body: unknown, key: string, maximumLength: number): string {
  const value = body && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximumLength) {
    throw new AppError(`${key} is required.`, {
      code: 'INVALID_COMMIT_RECEIPT',
      statusCode: 400,
    });
  }
  return normalized;
}

function readBearerToken(request: Request): string {
  // Commit receipts are submitted by an execution-scoped Git hook, not by a
  // browser actor.  Keep this service-to-service boundary on the same strict
  // RFC 6750 parser as REST/WebSocket auth: arrays, alternate schemes,
  // comma-separated credentials, and malformed values must never become a
  // 500 or be accepted as a token.  The route is additionally loopback-only
  // and the execution service hashes/validates the short-lived token.
  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
    throw new AppError('A commit receipt token is required.', {
      code: 'COMMIT_RECEIPT_TOKEN_REQUIRED',
      statusCode: 401,
    });
  }
  return token;
}

function normalizeRemoteAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function assertLocalHostRequest(request: Request): void {
  const localAddresses = new Set(['127.0.0.1', '::1']);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      localAddresses.add(normalizeRemoteAddress(address.address));
    }
  }
  const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress ?? '');
  if (!localAddresses.has(remoteAddress)) {
    throw new AppError('Commit receipts are accepted only from this CloudCLI host.', {
      code: 'COMMIT_RECEIPT_LOCAL_HOST_REQUIRED',
      statusCode: 403,
    });
  }
}

/** Authenticated API for actor attribution, guides, and snapshot management. */
export function createCollaborationRoutes(
  services: PrivateCollaborationServices,
): express.Router {
  const router = express.Router();
  // Creating/revoking a share persists application metadata and materializes
  // a transcript snapshot. Keep it separate from repository/file writes so a
  // product/QA deployment can support collaboration while still remaining
  // unable to mutate source code. The default guard keeps standalone mounts
  // safe; the production composition root injects its startup-resolved policy.
  const startupPolicy = captureDeploymentPolicy(services.deploymentPolicy);
  const sessionWriteGuard = services.capabilityGuard
    ? services.capabilityGuard('session.write')
    : createDeploymentPolicyGuard({
      policy: startupPolicy,
      capability: 'session.write',
    });

  router.get('/me', (request, response, next) => {
    try {
      const actor = services.actors.getActorByUserId(readAuthenticatedHttpUserId(request));
      response.json(createApiSuccessResponse({ actor }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/identity-enrollments', (request, response, next) => {
    try {
      assertEnrollmentAdmin(request);
      const enrollments = services.actors.listPendingIdentityEnrollments();
      response.setHeader('Cache-Control', 'private, no-store, max-age=0');
      response.json(createApiSuccessResponse({ enrollments }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId', (request, response, next) => {
    try {
      const sessionId = readPathValue(request.params.sessionId, 'sessionId');
      const attribution = services.actors.getSessionAttribution(sessionId);
      response.json(createApiSuccessResponse({ sessionId, attribution }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId/events', (request, response, next) => {
    try {
      const sessionId = readPathValue(request.params.sessionId, 'sessionId');
      const parsedLimit = Number.parseInt(String(request.query.limit ?? '100'), 10);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
      const events = services.actors.listSessionEvents(sessionId, limit);
      response.json(createApiSuccessResponse({ sessionId, events }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/commit-receipts', (request, response, next) => {
    try {
      const receipts = services.executionAttribution.listCommitReceipts({
        sessionId: readOptionalQueryValue(request.query.sessionId),
        taskId: readOptionalQueryValue(request.query.taskId),
        limit: readReceiptLimit(request.query.limit),
      });
      response.setHeader('Cache-Control', 'private, no-store, max-age=0');
      response.json(createApiSuccessResponse({ receipts }));
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/projects/:projectId/guide',
    asyncHandler(async (request, response) => {
      const projectId = readPathValue(request.params.projectId, 'projectId');
      response.json(createApiSuccessResponse(await services.getProjectGuide(projectId)));
    }),
  );

  router.post(
    '/sessions/:sessionId/shares',
    sessionWriteGuard,
    asyncHandler(async (request, response) => {
      const sessionId = readPathValue(request.params.sessionId, 'sessionId');
      const result = await services.sessionShares.create({
        sessionId,
        createdByUserId: readAuthenticatedHttpUserId(request),
        expiresInHours: readExpiryHours(request.body),
      });
      response.status(201).json(createApiSuccessResponse(result));
    }),
  );

  router.get(
    '/sessions/:sessionId/shares',
    asyncHandler(async (request, response) => {
      const sessionId = readPathValue(request.params.sessionId, 'sessionId');
      const shares = services.sessionShares.listActiveForSession({
        sessionId,
        createdByUserId: readAuthenticatedHttpUserId(request),
      });
      response.setHeader('Cache-Control', 'private, no-store, max-age=0');
      response.json(createApiSuccessResponse({ sessionId, shares }));
    }),
  );

  router.delete(
    '/shares/:shareId',
    sessionWriteGuard,
    asyncHandler(async (request, response) => {
      const shareId = readPathValue(request.params.shareId, 'shareId');
      const result = services.sessionShares.revoke(shareId, readAuthenticatedHttpUserId(request));
      response.json(createApiSuccessResponse(result));
    }),
  );

  return router;
}

/** Compatibility factory for callers that inject only the trusted actor service. */
export function createCollaborationRouter(actorService: ActorService): express.Router {
  return createCollaborationRoutes({
    ...DEFAULT_SHARE_GUIDE_SERVICES,
    actors: actorService,
    executionAttribution: executionAttributionService,
  });
}

/**
 * Options for the loopback commit-receipt bridge.
 *
 * The bridge is also exported as a standalone factory for alternate hosts and
 * focused tests.  When no guard is injected, the deployment policy is
 * captured once while the router is constructed; it is never re-parsed from
 * mutable process.env for each receipt request.
 */
export type InternalCommitReceiptRoutesOptions = {
  /** Startup policy, or a resolver evaluated exactly once by this factory. */
  deploymentPolicy?: DeploymentPolicy | (() => DeploymentPolicy);
  /** Production composition-root guard; takes precedence over the fallback. */
  capabilityGuard?: (operation: string) => RequestHandler;
};

function captureDeploymentPolicy(
  policy: InternalCommitReceiptRoutesOptions['deploymentPolicy'],
): DeploymentPolicy {
  return typeof policy === 'function' ? policy() : policy ?? parseDeploymentPolicy();
}

/** Loopback-only endpoint called by execution-scoped Git post-commit hooks. */
export function createInternalCommitReceiptRoutes(
  service: ExecutionAttributionService,
  options: InternalCommitReceiptRoutesOptions = {},
): express.Router {
  const router = express.Router();
  // A commit receipt records a real Git commit and therefore is itself a
  // Git-write side effect.  The production mount injects its immutable guard;
  // standalone/alternate mounts capture a trusted startup policy here so a
  // product/QA process cannot accept receipts merely because the caller has a
  // valid loopback token.
  const receiptWriteGuard = options.capabilityGuard
    ? options.capabilityGuard('git.write')
    : createDeploymentPolicyGuard({
      policy: captureDeploymentPolicy(options.deploymentPolicy),
      capability: 'git.write',
    });
  router.post(
    '/',
    receiptWriteGuard,
    asyncHandler(async (request, response) => {
      assertLocalHostRequest(request);
      const receipt = await service.recordCommitReceipt({
        receiptToken: readBearerToken(request),
        runId: readBodyString(request.body, 'runId', 128),
        repoPath: readBodyString(request.body, 'repoPath', 4096),
        commitSha: readBodyString(request.body, 'commitSha', 128),
      });
      response.setHeader('Cache-Control', 'no-store');
      response.status(201).json(createApiSuccessResponse({ receipt }));
    }),
  );
  return router;
}

function setPublicShareHeaders(response: Response): void {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

/** Unauthenticated API authorized solely by a random, expiring share token. */
export function createPublicShareRoutes(
  services: ShareGuideServices = DEFAULT_SHARE_GUIDE_SERVICES,
): express.Router {
  const router = express.Router();

  router.get('/:token', (request, response, next) => {
    setPublicShareHeaders(response);
    try {
      const token = readPathValue(request.params.token, 'token');
      response.json(createApiSuccessResponse(services.sessionShares.getPublic(token)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/** Applies privacy headers to the public SPA viewer before static/fallback handling. */
export function publicSharePageHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  setPublicShareHeaders(response);
  next();
}
