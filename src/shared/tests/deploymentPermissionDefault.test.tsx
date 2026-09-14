import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, test, vi } from 'vitest';

import { DeploymentPolicyProvider, useDeploymentPolicy } from '@/shared/context/DeploymentPolicyContext';

const mocks = vi.hoisted(() => ({
  deploymentPolicy: vi.fn(),
  capabilities: vi.fn(),
  auth: { user: { id: 'test-user', username: 'Test User' }, token: 'test-token' },
}));

vi.mock('@/modules/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/shared/api', () => ({
  api: { deploymentPolicy: mocks.deploymentPolicy, capabilities: mocks.capabilities },
}));

const writableCapabilities = {
  'repo.write': true,
  'file.write': true,
  'git.write': true,
  'shell.exec': true,
  'provider.runtime': true,
};

function renderPolicy() {
  return renderHook(() => useDeploymentPolicy(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <DeploymentPolicyProvider>{children}</DeploymentPolicyProvider>
    ),
  });
}

beforeEach(() => {
  mocks.deploymentPolicy.mockReset();
  mocks.capabilities.mockReset();
});

test.each([
  ['developer opt-in', 'developer', 'bypassPermissions', writableCapabilities, 'bypassPermissions'],
  ['read-only with contradictory capabilities', 'product-qa-readonly', 'bypassPermissions', writableCapabilities, 'default'],
  ['developer without shell execution', 'developer', 'bypassPermissions', { 'agent.use': true, 'file.write': true }, 'default'],
  ['other writable profile', 'self-hosted', 'bypassPermissions', writableCapabilities, 'default'],
  ['older server', 'developer', undefined, writableCapabilities, 'default'],
  ['unknown mode', 'developer', 'unrestricted', writableCapabilities, 'default'],
])('%s parses the server default conservatively', async (_label, profile, mode, capabilities, expected) => {
  mocks.deploymentPolicy.mockResolvedValue(new Response(JSON.stringify({
    data: { profile, capabilities, defaultPermissionMode: mode },
  })));
  const { result } = renderPolicy();

  await waitFor(() => assert.equal(result.current.status, 'ready'));
  assert.equal(result.current.policy.defaultPermissionMode, expected);
});

test('policy loading and request failure retain read-only controls', async () => {
  let failRequest!: (reason: Error) => void;
  mocks.deploymentPolicy.mockReturnValue(new Promise((_resolve, reject) => { failRequest = reject; }));
  const { result } = renderPolicy();

  assert.equal(result.current.status, 'loading');
  assert.equal(result.current.isReadOnly, true);
  assert.equal(result.current.can('agent.use'), false);
  failRequest(new Error('unavailable'));

  await waitFor(() => assert.equal(result.current.status, 'error'));
  assert.equal(result.current.isReadOnly, true);
  assert.notEqual(result.current.policy.defaultPermissionMode, 'bypassPermissions');
});
