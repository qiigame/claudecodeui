import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';

import { canStartEnabledPluginServers } from '../plugin-process.service.js';

test('plugin subprocess startup requires an explicit plugin execution capability', () => {
  const readonlyPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  const developerPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });

  assert.equal(canStartEnabledPluginServers(undefined), false);
  assert.equal(canStartEnabledPluginServers(readonlyPolicy), false);
  assert.equal(canStartEnabledPluginServers(developerPolicy), true);
});

test('plugin.use is a narrower execution grant and readonly profiles cannot enable it', () => {
  const executionOnlyPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'platform',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'plugin.use=true',
  });
  const readonlyPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'plugin.use=true',
  });

  assert.equal(canStartEnabledPluginServers(executionOnlyPolicy), true);
  assert.equal(canStartEnabledPluginServers(readonlyPolicy), false);
});
