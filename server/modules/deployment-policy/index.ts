// Public deployment-policy contract used by server composition roots and
// feature modules. Implementation details remain in the service file.
export {
  DEPLOYMENT_CAPABILITIES,
  DEPLOYMENT_POLICY_ENVIRONMENT_KEYS,
  assertDeploymentCapability,
  captureDeploymentPolicy,
  canonicalizePath,
  createDeploymentGuard,
  createDeploymentPolicyContextMiddleware,
  createDeploymentPolicyGuard,
  createDeploymentPolicyMiddleware,
  deploymentCapabilityForHttpMethod,
  hasDeploymentCapability,
  hasPluginExecutionCapability,
  isCanonicalPathInside,
  isDeploymentProfile,
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  readDeploymentPolicyRequestContext,
  resolveCanonicalPath,
  type DeploymentCapability,
  type DeploymentCapabilities,
  type DeploymentEnvironment,
  type DeploymentGuardOptions,
  type DeploymentPolicy,
  type DeploymentPolicySource,
  type DeploymentPolicyActor,
  type DeploymentPolicyMiddlewareOptions,
  type DeploymentPolicyRequestContext,
  type DeploymentProfile,
} from './deployment-policy.service.js';

// Route-mount helpers: used by the server composition root and its
// production-mount HTTP tests to keep auth/guard/router ordering identical.
export {
  mountPreApiKeyCapabilityRoute,
  mountProtectedApiRoute,
} from './protected-route-mount.js';
