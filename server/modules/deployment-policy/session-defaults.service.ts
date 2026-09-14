import { AppError } from '@/shared/index.js';

import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  type DeploymentEnvironment,
  type DeploymentPolicy,
} from './deployment-policy.service.js';

/**
 * Resolves the new-conversation preference for the server composition root's
 * authenticated deployment-policy response. Capture this value at startup;
 * request data and browser storage must never select a deployment profile.
 * This preference does not grant tool capabilities or replace runtime guards.
 * Existing conversations retain their own permission selection.
 */
export function resolveDefaultPermissionMode(
  policy: DeploymentPolicy,
  environment: DeploymentEnvironment = process.env,
): 'default' | 'bypassPermissions' {
  const configured = environment.CLOUDCLI_DEFAULT_PERMISSION_MODE?.trim() || 'default';
  if (configured !== 'default' && configured !== 'bypassPermissions') {
    throw new AppError('CLOUDCLI_DEFAULT_PERMISSION_MODE must be default or bypassPermissions.', {
      code: 'INVALID_DEFAULT_PERMISSION_MODE',
      statusCode: 400,
    });
  }

  // A shared binary can serve both a writable operator installation and a
  // product/QA installation. Copying the operator preference to another
  // profile must not turn new QA conversations into unattended tool runs.
  const writableDeveloper = policy.profile === 'developer' && [
    DEPLOYMENT_CAPABILITIES.REPO_WRITE,
    DEPLOYMENT_CAPABILITIES.FILE_WRITE,
    DEPLOYMENT_CAPABILITIES.GIT_WRITE,
    DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE,
    DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
  ].every((capability) => hasDeploymentCapability(policy, capability));
  return configured === 'bypassPermissions' && writableDeveloper
    ? 'bypassPermissions'
    : 'default';
}
