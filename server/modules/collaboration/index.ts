// Private routes are JWT-protected; publicShareRoutes is authorized by its random expiring token.
export {
  createCollaborationModule,
  createInternalCommitReceiptModule,
  collaborationRoutes,
  internalCommitReceiptRoutes,
  publicShareRoutes,
} from './collaboration.module.js';
export { publicSharePageHeaders } from './collaboration.routes.js';
// Used by Auth, Providers, Projects, and WebSocket to persist trusted actor attribution.
export { collaborationService } from './collaboration.service.js';
export type { ActorWriteOptions } from './collaboration.repository.js';
// Used by WebSocket runtimes to isolate Git identity and persist commit receipts.
export { executionAttributionService } from './execution-attribution.service.js';
// Used by Auth and execution attribution to resolve the coordination registry.
export { identityRegistryService } from './identity-registry.service.js';
export type {
  IdentityRegistryOptions,
  ResolveDingTalkBridgeInput,
  ResolvedDingTalkIdentity,
} from './identity-registry.service.js';
export {
  configureIdentityRegistryRequirement,
  isIdentityRegistryRequired,
} from './identity-registry.service.js';
export { createDingTalkBridgeRoutes } from './dingtalk-bridge.routes.js';
