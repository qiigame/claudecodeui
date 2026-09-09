import express from 'express';
import type { Request, Response } from 'express';

import {
  captureDeploymentPolicy,
  createDeploymentPolicyGuard,
  DEPLOYMENT_CAPABILITIES,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value;
}

export type ScheduledMessagesRouterOptions = {
  /** Startup policy (or a source evaluated once) for standalone mounts. */
  deploymentPolicy?: DeploymentPolicySource;
};

/** Builds the authenticated scheduled-message router. */
export function createScheduledMessagesRouter(
  options: ScheduledMessagesRouterOptions = {},
): express.Router {
  const router = express.Router();
  // Keep the side-effect boundary inside the feature router as well as in the
  // production composition root. Capture the fallback once so an alternate
  // mount cannot reopen scheduling by mutating process.env between requests.
  const startupPolicy = captureDeploymentPolicy(options.deploymentPolicy);
  const scheduledMessageMutationGuard = createDeploymentPolicyGuard({
    policy: startupPolicy,
    capability: DEPLOYMENT_CAPABILITIES.AGENT_USE,
  });

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      const userId = readUserId(req);
      res.json(createApiSuccessResponse(
        sessionId
          ? scheduledMessagesService.listForSession(userId, sessionId)
          : scheduledMessagesService.listPending(userId),
      ));
    }),
  );

  router.post(
    '/',
    scheduledMessageMutationGuard,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = scheduledMessagesService.schedule({
        userId: readUserId(req),
        sessionId: readString(body.sessionId, 'sessionId'),
        content: readString(body.content, 'content'),
        options: body.options,
        scheduledFor: readString(body.scheduledFor, 'scheduledFor'),
      });
      res.status(201).json(createApiSuccessResponse(result));
    }),
  );

  router.delete(
    '/:id',
    scheduledMessageMutationGuard,
    asyncHandler(async (req: Request, res: Response) => {
      scheduledMessagesService.cancel(readUserId(req), readString(req.params.id, 'id'));
      res.json(createApiSuccessResponse({ cancelled: true }));
    }),
  );

  return router;
}

const router = createScheduledMessagesRouter();

export default router;
