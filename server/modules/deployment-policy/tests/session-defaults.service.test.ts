import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/index.js';

import {
  parseDeploymentPolicy,
  resolveDefaultPermissionMode,
} from '../index.js';

test('an SSO developer deployment opts into unattended new conversations explicitly', () => {
  const environment = {
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_REQUIRE_DINGTALK_AUTH: 'true',
  };
  const policy = parseDeploymentPolicy(environment);
  assert.equal(resolveDefaultPermissionMode(policy, environment), 'default');
  assert.equal(resolveDefaultPermissionMode(policy, {
    ...environment,
    CLOUDCLI_DEFAULT_PERMISSION_MODE: 'bypassPermissions',
  }), 'bypassPermissions');
});

test('copying the operator default cannot reopen readonly or implicit SSO profiles', () => {
  for (const environment of [
    { CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' },
    { CLOUDCLI_REQUIRE_DINGTALK_AUTH: 'true' },
    { CLOUDCLI_DEPLOYMENT_PROFILE: 'platform' },
    {},
  ]) {
    const configured = {
      ...environment,
      CLOUDCLI_DEFAULT_PERMISSION_MODE: 'bypassPermissions',
    };
    assert.equal(resolveDefaultPermissionMode(parseDeploymentPolicy(configured), configured), 'default');
  }
});

test('removing a developer execution capability disables the unattended default', () => {
  for (const capability of ['repo.write', 'file.write', 'git.write', 'shell.exec', 'provider.runtime']) {
    const environment = {
      CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
      CLOUDCLI_DEFAULT_PERMISSION_MODE: 'bypassPermissions',
      CLOUDCLI_DEPLOYMENT_CAPABILITIES: `${capability}=false`,
    };
    assert.equal(resolveDefaultPermissionMode(parseDeploymentPolicy(environment), environment), 'default');
  }
});

test('an invalid new-conversation preference fails startup validation', () => {
  const policy = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'developer' });
  assert.throws(() => resolveDefaultPermissionMode(policy, {
    CLOUDCLI_DEFAULT_PERMISSION_MODE: 'bypass-permissions',
  }), (error: unknown) => error instanceof AppError && error.code === 'INVALID_DEFAULT_PERMISSION_MODE');
});
