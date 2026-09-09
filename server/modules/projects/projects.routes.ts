import express from 'express';
import type { RequestHandler } from 'express';

import { AUTH_DEPLOYMENT_MODE } from '@/modules/auth/index.js';
import {
  collaborationService,
} from '@/modules/collaboration/index.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import {
  getProjectTaskMaster,
  projectTaskMasterResponse,
} from '@/modules/projects/services/projects-has-taskmaster.service.js';
import {
  AppError,
  asyncHandler,
  createApiSuccessResponse,
  readAuthenticatedHttpUserId,
} from '@/shared/utils.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
import {
  createDeploymentPolicyGuard,
  captureDeploymentPolicy,
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';

type DeploymentPolicyRequest = express.Request & {
  deploymentPolicy?: DeploymentPolicy;
};

const router = express.Router();

// This legacy singleton is also mounted by lightweight integrations that do
// not install the application-level policy context middleware. Capture the
// trusted environment once so such mounts cannot change authorization by
// mutating process.env between requests. Production requests may still carry
// a more specific, startup-resolved request snapshot from the composition
// root; the middleware below only fills the missing fallback.
const standaloneDeploymentPolicy = captureDeploymentPolicy();

/**
 * Returns whether the project TaskMaster endpoint may expose its legacy
 * absolute `projectPath` field. Product/QA deployments never expose host
 * layout; a writable developer process keeps compatibility unless the
 * request is a non-admin DingTalk actor in a managed SSO flow.
 */
export function shouldExposeTaskMasterProjectPath(request: express.Request): boolean {
  const policy = (request as DeploymentPolicyRequest).deploymentPolicy ?? standaloneDeploymentPolicy;
  if (isDeploymentReadOnly(policy)) {
    return false;
  }

  const user = (request as express.Request & {
    user?: {
      actor?: { provider?: unknown } | null;
      permissions?: { manageSettings?: unknown } | null;
    };
  }).user;
  return !(user?.actor?.provider === 'dingtalk'
    && user.permissions?.manageSettings !== true);
}

router.use((request: DeploymentPolicyRequest, _response, next) => {
  if (!request.deploymentPolicy) {
    request.deploymentPolicy = standaloneDeploymentPolicy;
  }
  next();
});

/**
 * Project management is a deployment capability, rather than a UI concern.
 * Product/QA deployments intentionally expose the GET project views while
 * omitting `project.mutate`; the guard therefore protects every route below
 * that can create, clone, rename, archive, restore, or otherwise alter a
 * project record.  A trusted request snapshot may refine the startup
 * fallback, but an alternate mount never reparses process.env for each
 * request.
 */
const projectMutationGuard = createDeploymentPolicyGuard({
  capability: DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
});

/**
 * Read access is explicit as well.  This keeps a deployment profile honest:
 * Product/QA may browse project metadata, while a future profile can disable
 * project discovery altogether without changing individual handlers.
 */
const projectReadGuard = createDeploymentPolicyGuard({
  capability: DEPLOYMENT_CAPABILITIES.PROJECT_READ,
});

/**
 * A project-record mutation is not, by itself, proof that the operation may
 * touch a checkout. Keep the side effects of the two project-creation flows
 * explicit so a custom deployment can grant project metadata administration
 * without accidentally granting filesystem or Git access.
 *
 * `create-project` creates a directory and registers it as a repository. A
 * clone additionally starts `git clone`, which is represented by the narrower
 * `git.fetch` capability (rather than the broader local branch/commit
 * `git.write` capability). Force deletion removes transcript files; soft
 * archive remains a database-only project mutation.
 */
export const PROJECT_WRITE_CAPABILITIES = Object.freeze({
  create: Object.freeze([
    DEPLOYMENT_CAPABILITIES.FILE_WRITE,
    DEPLOYMENT_CAPABILITIES.REPO_WRITE,
  ] as const),
  clone: Object.freeze([
    DEPLOYMENT_CAPABILITIES.FILE_WRITE,
    DEPLOYMENT_CAPABILITIES.REPO_WRITE,
    DEPLOYMENT_CAPABILITIES.GIT_FETCH,
  ] as const),
  forceDelete: Object.freeze([
    DEPLOYMENT_CAPABILITIES.FILE_WRITE,
  ] as const),
});

export type ProjectWriteOperation = keyof typeof PROJECT_WRITE_CAPABILITIES;

/**
 * Builds the narrow capability guard for one project side-effect class. The
 * optional policy argument is useful to embedders/tests; production leaves it
 * unset so the immutable request policy attached by `server/index.ts` wins.
 */
export function createProjectWriteCapabilityGuard(
  operation: ProjectWriteOperation,
  policy?: DeploymentPolicy | (() => DeploymentPolicy),
): RequestHandler {
  return createDeploymentPolicyGuard({
    policy,
    capabilities: PROJECT_WRITE_CAPABILITIES[operation],
  });
}

const projectCreateCapabilityGuard = createProjectWriteCapabilityGuard('create');
const projectCloneCapabilityGuard = createProjectWriteCapabilityGuard('clone');
const projectForceDeleteFileGuard = createProjectWriteCapabilityGuard('forceDelete');

/**
 * `DELETE /:projectId` has two behaviors. Only the force branch unlinks
 * transcript files, so require `file.write` conditionally and preserve the
 * existing soft-archive behavior for deployments that intentionally grant
 * only project metadata mutation.
 */
export function createForceProjectDeleteGuard(
  policy?: DeploymentPolicy | (() => DeploymentPolicy),
): RequestHandler {
  const fileWriteGuard = policy === undefined
    ? projectForceDeleteFileGuard
    : createProjectWriteCapabilityGuard('forceDelete', policy);

  return (request, response, next) => {
    if (request.query?.force !== 'true') {
      next();
      return;
    }

    fileWriteGuard(request, response, next);
  };
}

const forceProjectDeleteGuard = createForceProjectDeleteGuard();

type AuthenticatedUser = {
  id?: number | string;
};

/**
 * Session synchronization is a read-triggered metadata write: provider
 * scanners upsert rows/cursors and prune orphaned sessions.  Do not let a
 * custom read-only capability profile perform that work merely by opening a
 * project list.  The composition middleware attaches the immutable policy;
 * the parser fallback keeps standalone route consumers deterministic.
 */
export function shouldSkipProjectSynchronization(request: express.Request): boolean {
  const policy = (request as DeploymentPolicyRequest).deploymentPolicy ?? standaloneDeploymentPolicy;
  // `session.write` covers safe conversation metadata mutations (titles,
  // attribution, archive flags), so it intentionally remains enabled for
  // product/QA. Provider synchronization is a separate read-triggered index
  // write; an explicitly read-only deployment must skip it even when that
  // metadata capability is present.
  return isDeploymentReadOnly(policy)
    || !hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SESSION_WRITE);
}

type ProjectActorGuardDependencies = {
  /** Whether this server's authentication boundary requires a DingTalk actor. */
  requiresDingTalk: boolean;
  /** Resolves the current actor from the authoritative server-side store. */
  getActorByUserId: typeof collaborationService.getActorByUserId;
  /** Revalidates the actor against the current identity registry. */
  assertActorCanWrite: typeof collaborationService.assertActorCanWrite;
};

/**
 * Guards streaming clone requests before any filesystem or Git side effect.
 * EventSource clients still use GET, so method-based auth middleware cannot
 * identify this endpoint as a mutation. In a managed DingTalk deployment, or
 * whenever the request already carries a DingTalk actor, require a current
 * verified project identity and refresh it immediately before cloning. A
 * local developer deployment may still have a stale DingTalk actor row from
 * an earlier SSO setup; that row is not an authority to narrow the explicit
 * local deployment profile.
 */
export function createVerifiedProjectActorGuard(
  dependencies: ProjectActorGuardDependencies = {
    requiresDingTalk: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
    getActorByUserId: collaborationService.getActorByUserId,
    assertActorCanWrite: collaborationService.assertActorCanWrite,
  },
): express.RequestHandler {
  return (request, _response, next) => {
    if (!dependencies.requiresDingTalk) {
      next();
      return;
    }

    try {
      const userId = readAuthenticatedHttpUserId(request);
      const actor = dependencies.getActorByUserId(userId);
      if (
        !actor
        || actor.provider !== 'dingtalk'
        || actor.identityStatus !== 'verified'
        || !actor.personId
      ) {
        throw new AppError(
          'Your project identity is pending registration. Read-only access remains available.',
          { code: 'IDENTITY_ENROLLMENT_REQUIRED', statusCode: 403 },
        );
      }

      // The actor snapshot may have been loaded before a registry change. The
      // write assertion performs the authoritative, current binding check.
      dependencies.assertActorCanWrite(userId, {
        // Clone is a filesystem/Git mutation even though its progress
        // transport is GET/SSE. Explicitly require the registry in managed
        // DingTalk composition when this router is used standalone.
        requireRegistry: dependencies.requiresDingTalk,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}

const verifiedProjectActorGuard = createVerifiedProjectActorGuard();

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

/**
 * Returns whether a query value contains any non-empty string occurrence.
 * Express's default query parser represents repeated keys as arrays.  Looking
 * only at the first element would let a raw PAT survive in a later duplicate
 * (for example `?githubToken=&githubToken=secret`), where it remains visible
 * in browser history and proxy access logs even though the handler ignores it.
 */
function hasQueryStringValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  return Array.isArray(value)
    && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

/**
 * Raw GitHub tokens must never travel in a GET query string.  EventSource
 * clients still use the legacy GET clone endpoint, but query parameters are
 * routinely captured by browser history, reverse-proxy access logs, and
 * monitoring systems.  Token ids remain safe to pass in GET; a new token must
 * use the POST transport whose body is not part of the URL.  Keep this check
 * before SSE headers are written so the rejection itself cannot echo or log
 * the secret.
 */
export function assertNoRawGithubTokenOnGet(
  method: string,
  requestInput: Record<string, unknown>,
): void {
  if (method.toUpperCase() !== 'GET') {
    return;
  }

  // Older clients used a few spellings for the inline PAT. Keep the
  // authentication `token` query parameter compatible for EventSource, but
  // reject every known GitHub-token alias before SSE headers are written. The
  // value is never included in the error, so a proxy/client cannot reflect it
  // back into a browser-visible response.
  const rawGithubTokenKeys = [
    'newGithubToken',
    'githubToken',
    'rawGithubToken',
    'github_token',
    'github-token',
    'access_token',
    'accessToken',
  ] as const;
  if (rawGithubTokenKeys.some((key) => hasQueryStringValue(requestInput[key]))) {
    throw new AppError(
      'Raw GitHub tokens are not accepted in GET requests; use POST /api/projects/clone-progress.',
      {
        code: 'CLONE_TOKEN_QUERY_NOT_ALLOWED',
        statusCode: 400,
      },
    );
  }
}

/**
 * IncomingMessage.destroyed becomes true when a request body has been fully
 * consumed, even while its response is still being served.  Clone progress
 * must therefore use the response/connection lifecycle to detect a client
 * disconnect; treating `req.destroyed` as cancellation would abort every
 * ordinary POST (and many GET) clone requests before Git is spawned.
 */
export function isCloneProgressClientClosed(
  requestClosed: boolean,
  response: Pick<express.Response, 'writableEnded' | 'destroyed'>,
): boolean {
  return requestClosed || (response.destroyed === true && response.writableEnded !== true);
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

function resolveRouteErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Failed to clone repository';
}

router.get(
  '/',
  projectReadGuard,
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      shouldSkipProjectSynchronization(req) ||
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
    });
    res.json(projects);
  }),
);

router.get(
  '/archived',
  projectReadGuard,
  asyncHandler(async (req, res) => {
    const projects = await getArchivedProjectsWithSessions({
      skipSynchronization: shouldSkipProjectSynchronization(req),
    });
    res.json(createApiSuccessResponse({ projects }));
  }),
);

router.get(
  '/:projectId/sessions',
  projectReadGuard,
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, { limit, offset });
    res.json(sessionsPage);
  }),
);

router.post(
  '/create-project',
  projectMutationGuard,
  projectCreateCapabilityGuard,
  asyncHandler(async (req, res) => {
    const requestBody = req.body as Record<string, unknown>;
    const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
    const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

    if (requestBody.workspaceType !== undefined) {
      throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
        code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
      throw new AppError('Repository cloning is not supported on create-project', {
        code: 'CLONE_NOT_SUPPORTED_ON_CREATE_PROJECT',
        statusCode: 400,
        details: 'Use /api/projects/clone-progress for cloning workflows',
      });
    }

    const projectCreationResult = await createProject({
      projectPath,
      customName,
    });

    res.json({
      success: true,
      project: projectCreationResult.project,
      message:
        projectCreationResult.outcome === 'reactivated_archived'
          ? 'Archived project path reused successfully'
          : 'Project created successfully',
    });
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  projectMutationGuard,
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds);
    res.json({ success: true, updated });
  }),
);

/**
 * Streams clone progress. GET is retained for older EventSource clients; POST
 * is also supported so new clients can keep raw GitHub tokens out of URLs.
 */
const cloneProgressHandler = async (req: express.Request, res: express.Response) => {
  const requestInput = req.method.toUpperCase() === 'POST'
    ? (req.body as Record<string, unknown> | undefined) ?? {}
    : req.query as Record<string, unknown>;

  // Do this before switching the response to SSE. In addition to keeping the
  // token out of the response body, a normal 400 lets an EventSource client
  // surface a clear migration message while preserving the old no-token GET.
  try {
    assertNoRawGithubTokenOnGet(req.method, requestInput);
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
      });
      return;
    }
    throw error;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type: string, data: Record<string, unknown>) => {
    if (res.writableEnded || res.destroyed) {
      return;
    }

    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let requestClosed = false;
  let cloneOperation: Awaited<ReturnType<typeof startCloneProject>> | null = null;
  const markRequestClosed = () => {
    if (res.writableEnded) {
      return;
    }
    requestClosed = true;
    cloneOperation?.cancel();
  };
  // `req.close`/`req.destroyed` describe completion of the incoming message,
  // not the lifetime of the SSE response.  Listen on the response instead;
  // `close` with writableEnded=false is the client-disconnect signal.
  res.on('close', markRequestClosed);
  req.on('aborted', markRequestClosed);

  try {
    const workspacePath = readQueryStringValue(requestInput.path);
    const githubUrl = readQueryStringValue(requestInput.githubUrl);
    const githubTokenId = readOptionalNumericQueryValue(requestInput.githubTokenId);
    const newGithubToken = readQueryStringValue(requestInput.newGithubToken) || null;

    const authenticatedUser = (req as typeof req & { user?: AuthenticatedUser }).user;
    const userId = authenticatedUser?.id;
    if (userId === undefined || userId === null) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }

    cloneOperation = await startCloneProject(
      {
        workspacePath,
        githubUrl,
        githubTokenId,
        newGithubToken,
        userId,
      },
      {
        onProgress: (message) => {
          sendEvent('progress', { message });
        },
        onComplete: ({ project, message }) => {
          sendEvent('complete', { project, message });
        },
        // startCloneProject performs asynchronous path/token lookups before
        // it can return the cancellable child handle. This probe closes that
        // handoff race when the fetch/EventSource disconnects during those
        // awaits; the service returns a no-op operation instead of spawning.
        isCancelled: () => isCloneProgressClientClosed(requestClosed, res),
      },
    );

    if (isCloneProgressClientClosed(requestClosed, res)) {
      cloneOperation.cancel();
      return;
    }
    await cloneOperation.waitForCompletion;
  } catch (error) {
    sendEvent('error', { message: resolveRouteErrorMessage(error) });
  } finally {
    res.off('close', markRequestClosed);
    req.off('aborted', markRequestClosed);
    if (!res.writableEnded) {
      res.end();
    }
  }
};

// Although these endpoints use a streaming response, opening one starts a
// clone operation and therefore must use the same mutation capability as the
// JSON mutation routes above. POST is the secure transport for new tokens.
router.get(
  '/clone-progress',
  projectReadGuard,
  projectMutationGuard,
  projectCloneCapabilityGuard,
  verifiedProjectActorGuard,
  cloneProgressHandler,
);
router.post(
  '/clone-progress',
  projectReadGuard,
  projectMutationGuard,
  projectCloneCapabilityGuard,
  verifiedProjectActorGuard,
  cloneProgressHandler,
);

router.get(
  '/:projectId/taskmaster',
  projectReadGuard,
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const taskMasterDetails = await getProjectTaskMaster(projectId);
    res.json(projectTaskMasterResponse(taskMasterDetails, {
      includeProjectPath: shouldExposeTaskMasterProjectPath(req),
    }));
  }),
);

router.put('/:projectId/rename', projectMutationGuard, (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

router.post(
  '/:projectId/toggle-star',
  projectMutationGuard,
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const { isStarred } = toggleProjectStar(projectId);
    res.json({ success: true, isStarred });
  }),
);

router.post(
  '/:projectId/restore',
  projectMutationGuard,
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    restoreArchivedProject(projectId);
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  projectMutationGuard,
  forceProjectDeleteGuard,
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const force = req.query.force === 'true';
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

export default router;
