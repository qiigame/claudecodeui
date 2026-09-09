// Compatibility re-export for modules that still import the legacy guard file.
export {
  createDeploymentGuard,
  createDeploymentPolicyGuard,
  type DeploymentGuardOptions,
  type DeploymentPolicyMiddlewareOptions,
} from './deployment-policy.service.js';
