import type { RequestHandler } from 'express';
import type { DeploymentPolicySource } from '@/modules/deployment-policy/index.js';

import {
  createCollaborationRoutes,
  createInternalCommitReceiptRoutes,
  createPublicShareRoutes,
} from './collaboration.routes.js';
import { collaborationService } from './collaboration.service.js';
import { executionAttributionService } from './execution-attribution.service.js';
import { getProjectGuide } from './project-guide.service.js';
import { sessionShareService } from './session-share.service.js';

/** Authenticated shared-workspace metadata, guide, and snapshot-management API. */
export const collaborationRoutes = createCollaborationRoutes({
  actors: collaborationService,
  executionAttribution: executionAttributionService,
  getProjectGuide,
  sessionShares: sessionShareService,
});

/**
 * Builds the production Collaboration router with the immutable deployment
 * policy injected by the server composition root. This keeps share creation
 * and revocation aligned with the same capability snapshot as the other API
 * modules while retaining the default export for standalone consumers/tests.
 */
export function createCollaborationModule(
  capabilityGuard: (operation: string) => RequestHandler,
  deploymentPolicy?: DeploymentPolicySource,
) {
  return createCollaborationRoutes({
    actors: collaborationService,
    executionAttribution: executionAttributionService,
    getProjectGuide,
    sessionShares: sessionShareService,
    capabilityGuard,
    deploymentPolicy,
  });
}

/**
 * Builds the internal commit-receipt bridge with the composition root's
 * startup capability snapshot.  The compatibility export below remains
 * available for standalone consumers, whose factory now captures its own
 * trusted policy and requires `git.write` by default.
 */
export function createInternalCommitReceiptModule(
  capabilityGuard: (operation: string) => RequestHandler,
) {
  return createInternalCommitReceiptRoutes(executionAttributionService, {
    capabilityGuard,
  });
}

/** Token-authorized immutable snapshot API; deliberately mounted before API auth. */
export const publicShareRoutes = createPublicShareRoutes();

/** Loopback and execution-token protected endpoint used by Git hooks. */
export const internalCommitReceiptRoutes = createInternalCommitReceiptRoutes(
  executionAttributionService,
);
