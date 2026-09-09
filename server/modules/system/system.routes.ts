import express from 'express';

import {
  captureDeploymentPolicy,
  createDeploymentPolicyGuard,
  DEPLOYMENT_CAPABILITIES,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  options: { deploymentPolicy?: DeploymentPolicySource } = {},
): express.Router {
  const router = express.Router();
  // System update executes package/git/shell side effects. Keep a direct or
  // alternate mount fail-closed when no composition-root guard is supplied;
  // the captured policy still permits the existing local developer profile.
  const updateGuard = createDeploymentPolicyGuard({
    policy: captureDeploymentPolicy(options.deploymentPolicy),
    capability: DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE,
  });

  router.post('/update', updateGuard, async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
