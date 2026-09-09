import express from 'express';

import {
  captureDeploymentPolicy,
  createDeploymentPolicyGuard,
  type DeploymentPolicy,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import type { WorktreeServices } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/**
 * Parses the project identifier shared by all Worktrees routes.
 *
 * Path resolution intentionally remains in the injected application service so
 * this transport layer never reaches into the Database module.
 */
function readProjectId(projectIdValue: unknown): string {
  const projectId = typeof projectIdValue === 'string' ? projectIdValue.trim() : '';
  if (!projectId) {
    throw new AppError('project is required', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  return projectId;
}

function readRequiredString(value: unknown, name: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) {
    throw new AppError(`${name} is required`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return parsed;
}

/**
 * Builds the Worktrees HTTP router around an injected application-service API.
 *
 * Keeping construction explicit lets route tests supply deterministic services
 * and ensures parsing remains the route layer's only responsibility.
 */
/**
 * Optional startup policy supplied by the application composition root.
 * Standalone route tests and older embedders may omit it, in which case the
 * deployment-policy guard resolves the trusted process environment as before.
 */
export type WorktreesRouterOptions = {
  deploymentPolicy?: DeploymentPolicySource;
};

/**
 * Builds the Worktrees router around application services and a deployment
 * policy. The policy is captured by the guard factory once, preventing a
 * request from changing authorization by mutating process environment state.
 */
export function createWorktreesRouter(
  services: WorktreeServices,
  options: WorktreesRouterOptions = {},
): express.Router {
  const router = express.Router();
  // Resolve a function source exactly once at construction. Passing the
  // source directly to the guard would evaluate it for every request and
  // could let an alternate mount drift from the startup policy.
  const startupPolicy = captureDeploymentPolicy(options.deploymentPolicy);

  /**
   * Worktree management can create branches, register projects, merge, and
   * remove directories.  Keep read-only planning/listing available to
   * Product/QA while requiring the deployment's explicit `worktree.mutate`
   * capability for every state-changing operation.  This is deliberately a
   * server-side guard; hiding controls in the client is not an authorization
   * boundary.
   */
  const worktreeMutationGuard = createDeploymentPolicyGuard({
    policy: startupPolicy,
    capability: 'worktree.mutate',
  });
  const worktreeReadGuard = createDeploymentPolicyGuard({
    policy: startupPolicy,
    capability: 'worktree.read',
  });

  router.get(
    '/session-plan',
    worktreeReadGuard,
    asyncHandler(async (req, res) => {
      const projectPath = services.resolveProjectPath(readProjectId(req.query.project));
      const result = await services.planSessionWorkspace(projectPath);
      res.json(createApiSuccessResponse(result));
    }),
  );

  router.get(
    '/',
    worktreeReadGuard,
    asyncHandler(async (req, res) => {
      const projectPath = services.resolveProjectPath(readProjectId(req.query.project));
      const result = await services.list({ projectPath });
      res.json(createApiSuccessResponse(result));
    }),
  );

  router.post(
    '/create',
    worktreeMutationGuard,
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const projectPath = services.resolveProjectPath(readProjectId(body.project));
      const branch = readRequiredString(body.branch, 'branch');
      const baseBranch = typeof body.baseBranch === 'string' ? body.baseBranch : null;

      const result = await services.createAndOpen({ projectPath, branch, baseBranch });
      res.json(createApiSuccessResponse(result));
    }),
  );

  router.post(
    '/open',
    worktreeMutationGuard,
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const projectPath = services.resolveProjectPath(readProjectId(body.project));
      const worktreePath = readRequiredString(body.worktreePath, 'worktreePath');

      const project = await services.open({ projectPath, worktreePath });
      res.json(createApiSuccessResponse({ project }));
    }),
  );

  router.post(
    '/merge',
    worktreeMutationGuard,
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const projectPath = services.resolveProjectPath(readProjectId(body.project));
      const worktreePath = readRequiredString(body.worktreePath, 'worktreePath');

      const result = await services.merge({
        projectPath,
        worktreePath,
        squash: typeof body.squash === 'boolean' ? body.squash : false,
        message: typeof body.message === 'string' ? body.message : null,
        removeAfterMerge: typeof body.removeAfterMerge === 'boolean' ? body.removeAfterMerge : false,
      });

      res.json(createApiSuccessResponse(result));
    }),
  );

  router.post(
    '/remove',
    worktreeMutationGuard,
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const projectPath = services.resolveProjectPath(readProjectId(body.project));
      const worktreePath = readRequiredString(body.worktreePath, 'worktreePath');

      const result = await services.remove({
        projectPath,
        worktreePath,
        force: typeof body.force === 'boolean' ? body.force : false,
        deleteBranch: typeof body.deleteBranch === 'boolean' ? body.deleteBranch : false,
      });

      res.json(createApiSuccessResponse(result));
    }),
  );

  return router;
}
