import express from 'express';

import {
  captureDeploymentPolicy,
  createDeploymentPolicyGuard,
  DEPLOYMENT_CAPABILITIES,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import type { createSettingsService } from './settings.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function userId(req: express.Request): number {
  return Number((req as AuthenticatedRequest).user?.id);
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Creates thin Settings transport handlers around the application service. */
export function createSettingsRouter(
  service: ReturnType<typeof createSettingsService>,
  options: { deploymentPolicy?: DeploymentPolicySource } = {},
): express.Router {
  const router = express.Router();
  // Keep standalone/alternate mounts behind a trusted startup policy too.
  // The production composition root still supplies its outer immutable guard;
  // this inner guard closes the gap when a host mounts the feature router
  // directly.  No deployment configuration means the existing local
  // self-hosted profile, while product/QA profiles deny settings writes.
  const policy = captureDeploymentPolicy(options.deploymentPolicy);
  const capabilityGuard = (capability: string) => createDeploymentPolicyGuard({
    policy,
    capability,
  });
  const settingsWriteGuard = capabilityGuard(DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE);
  const personalMutationGuard = capabilityGuard(DEPLOYMENT_CAPABILITIES.SESSION_WRITE);
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/api-keys', respond((req) => service.listApiKeys(userId(req))));
  router.post('/api-keys', settingsWriteGuard, respond((req) => service.createApiKey(userId(req), req.body?.keyName)));
  router.delete('/api-keys/:keyId', settingsWriteGuard, respond((req) => service.deleteApiKey(userId(req), Number(req.params.keyId))));
  router.patch('/api-keys/:keyId/toggle', settingsWriteGuard, respond((req) => service.toggleApiKey(
    userId(req), Number(req.params.keyId), req.body?.isActive,
  )));
  router.get('/credentials', respond((req) => service.listCredentials(
    userId(req), queryString(req.query.type),
  )));
  router.post('/credentials', settingsWriteGuard, respond((req) => service.createCredential(userId(req), req.body ?? {})));
  router.delete('/credentials/:credentialId', settingsWriteGuard, respond((req) => service.deleteCredential(
    userId(req), Number(req.params.credentialId),
  )));
  router.patch('/credentials/:credentialId/toggle', settingsWriteGuard, respond((req) => service.toggleCredential(
    userId(req), Number(req.params.credentialId), req.body?.isActive,
  )));
  router.get('/notification-preferences', respond((req) => service.getNotificationPreferences(userId(req))));
  router.put('/notification-preferences', personalMutationGuard, respond((req) => service.updateNotificationPreferences(
    userId(req), req.body ?? {},
  )));
  router.get('/push/vapid-public-key', respond(() => service.getVapidPublicKey()));
  router.post('/push/subscribe', personalMutationGuard, respond((req) => service.subscribeToPush(userId(req), req.body ?? {})));
  router.post('/push/unsubscribe', personalMutationGuard, respond((req) => service.unsubscribeFromPush(
    userId(req), req.body?.endpoint,
  )));
  return router;
}
