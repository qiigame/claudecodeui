import express, { type RequestHandler } from 'express';

import {
  captureDeploymentPolicy,
  createDeploymentPolicyMiddleware,
  DEPLOYMENT_CAPABILITIES,
} from '@/modules/deployment-policy/index.js';
import { AppError } from '@/shared/utils.js';

import { browserUseService } from './browser-use.service.js';

/** Narrow Browser service contract consumed by the REST transport. */
export type BrowserUseRouteService = Pick<
  typeof browserUseService,
  | 'getStatus'
  | 'getSettings'
  | 'updateSettings'
  | 'installRuntime'
  | 'listSessions'
  | 'stopSession'
  | 'deleteSession'
>;

/** Optional deployment capability factory supplied by the composition root. */
export type BrowserUseRouterOptions = {
  capabilityGuard?: (operation: string) => RequestHandler;
  service?: BrowserUseRouteService;
  /**
   * Shared Browser sessions currently use one internal agent owner. In a
   * managed DingTalk deployment, listing that collection is therefore an
   * administrator-only read rather than a per-user read. The composition
   * root must pass its startup auth decision; omitted standalone mounts retain
   * local/developer compatibility.
   */
  requireManagedSessionListAdmin?: boolean;
  /**
   * Optional equivalent controlled-actor assertion for hosts whose auth
   * principal is not decorated with CloudCLI's standard `permissions` shape.
   * It runs before `listSessions()` and may throw an AppError.
   */
  assertSessionListAccess?: (request: express.Request) => void;
};

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

/**
 * Creates the authenticated Browser REST router. Read endpoints remain
 * available in the product/QA profile, while lifecycle/configuration actions
 * are guarded before their service call (and before an install subprocess can
 * start). The server composition root supplies the deployment policy guard;
 * standalone consumers retain the historical unguarded constructor.
 */
export function createBrowserUseRouter(options: BrowserUseRouterOptions = {}): express.Router {
  const router = express.Router();
  const service = options.service ?? browserUseService;
  const requireManagedSessionListAdmin = options.requireManagedSessionListAdmin
    ?? false;
  // Even standalone mounts must honor the startup deployment policy. The
  // composition root injects its already-resolved policy to avoid reparsing;
  // the fallback keeps alternate hosts/tests from accidentally exposing
  // Browser mutations when they omit the optional constructor argument.
  const fallbackPolicy = options.capabilityGuard
    ? undefined
    : captureDeploymentPolicy();
  const capabilityGuard = options.capabilityGuard
    ?? ((operation: string) => createDeploymentPolicyMiddleware({
      policy: fallbackPolicy!,
      capability: operation,
    }));
  const sideEffectGuard: RequestHandler = capabilityGuard(DEPLOYMENT_CAPABILITIES.BROWSER_USE);
  const mcpWriteGuard: RequestHandler = capabilityGuard(DEPLOYMENT_CAPABILITIES.MCP_WRITE);
  const readGuard: RequestHandler = capabilityGuard(DEPLOYMENT_CAPABILITIES.BROWSER_READ);

  /**
   * `BrowserUseService` intentionally keeps an internal `agent` owner for
   * MCP/runtime compatibility. That owner is not a human identity, so a
   * normal authenticated member must not receive the complete shared session
   * list in a managed multi-user deployment. Require the server-derived,
   * verified DingTalk settings-admin capability before the in-memory list is
   * even touched. Local password/developer deployments retain the historical
   * read behavior.
   */
  const managedSessionListAccessGuard: RequestHandler = (request, _response, next) => {
    if (!requireManagedSessionListAdmin && !options.assertSessionListAccess) {
      next();
      return;
    }

    try {
      if (options.assertSessionListAccess) {
        options.assertSessionListAccess(request);
      } else {
        const requestUser = (request as express.Request & {
          user?: {
            id?: number | string;
            userId?: number | string;
            actor?: {
              userId?: number | string;
              provider?: unknown;
              personId?: unknown;
              identityStatus?: unknown;
            } | null;
            permissions?: { manageSettings?: unknown } | null;
          };
        }).user;
        const actor = requestUser?.actor;
        const requestUserId = requestUser?.id ?? requestUser?.userId;
        const actorUserId = actor?.userId;
        const sameUser = requestUserId !== undefined
          && actorUserId !== undefined
          && String(requestUserId) === String(actorUserId);
        if (!sameUser
          || actor?.provider !== 'dingtalk'
          || actor.identityStatus !== 'verified'
          || typeof actor.personId !== 'string'
          || actor.personId.trim() === ''
          || requestUser?.permissions?.manageSettings !== true) {
          throw new AppError(
            'Browser session listing requires a verified DingTalk settings administrator.',
            { code: 'BROWSER_SESSION_LIST_ACCESS_DENIED', statusCode: 403 },
          );
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  router.get('/status', readGuard, async (_req, res) => {
  try {
      res.json({ success: true, data: await service.getStatus() });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Browser status.',
    });
  }
  });

  router.get('/settings', readGuard, async (_req, res) => {
  try {
      res.json({ success: true, data: { settings: await service.getSettings() } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Browser settings.',
    });
  }
  });

  // Enabling/disabling Browser also registers or removes its provider MCP
  // server. Require both capabilities so a profile that permits Browser
  // runtime use cannot mutate provider configuration through this route.
  router.put('/settings', sideEffectGuard, mcpWriteGuard, async (req, res) => {
  try {
      const settings = await service.updateSettings(req.body || {});
    res.json({ success: true, data: { settings } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Browser settings.',
    });
  }
  });

  router.post('/runtime/install', sideEffectGuard, async (_req, res) => {
  try {
      const result = await service.installRuntime();
    res.status(result.success ? 200 : 500).json({
      success: result.success,
      data: result,
      error: result.success ? undefined : result.message,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to install Browser runtime.',
    });
  }
  });

  router.get('/sessions', readGuard, managedSessionListAccessGuard, async (_req, res) => {
  try {
      // The response contains the shared agent's live session metadata. Never
      // let a browser/proxy reuse an administrator's view for another actor.
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.json({ success: true, data: { sessions: await service.listSessions() } });
  } catch (error) {
    res.status(401).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list browser sessions.',
    });
  }
  });

  router.post('/sessions/:sessionId/stop', sideEffectGuard, async (req, res) => {
  try {
      const result = await service.stopSession(readParam(req.params.sessionId));
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop browser session.',
    });
  }
  });

  router.delete('/sessions/:sessionId', sideEffectGuard, async (req, res) => {
  try {
      const result = await service.deleteSession(readParam(req.params.sessionId));
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete browser session.',
    });
  }
  });

  return router;
}

const router = createBrowserUseRouter();

export default router;
