import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import ProtectedRoute from '@/modules/auth/ProtectedRoute';

const authState = vi.hoisted(() => ({
  user: null as {
    id?: number;
    username: string;
    actor?: { identityStatus?: string };
  } | null,
  authMode: null as 'dingtalk' | 'password' | 'platform' | 'unavailable' | null,
  isLoading: false,
  needsSetup: false,
  hasCompletedOnboarding: false,
  refreshOnboardingStatus: vi.fn() as Mock,
}));

const policyState = vi.hoisted(() => ({
  isReadOnly: false,
  status: 'ready' as 'loading' | 'ready' | 'error',
}));

vi.mock('@/modules/auth/context/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/shared/context/DeploymentPolicyContext', () => ({
  useDeploymentPolicy: () => policyState,
}));

vi.mock('@/modules/onboarding', () => ({
  Onboarding: () => <div>ONBOARDING_SENTINEL</div>,
}));

vi.mock('@/modules/auth/AuthLoadingScreen', () => ({
  default: () => <div>LOADING_SENTINEL</div>,
}));

vi.mock('@/modules/auth/IdentityAccessNotice', () => ({
  default: () => <div>IDENTITY_NOTICE_SENTINEL</div>,
}));

vi.mock('@/modules/auth/LoginForm', () => ({
  default: () => <div>LOGIN_SENTINEL</div>,
}));

vi.mock('@/modules/auth/SetupForm', () => ({
  default: () => <div>SETUP_SENTINEL</div>,
}));

beforeEach(() => {
  authState.user = {
    id: 1,
    username: '测试成员',
    actor: { identityStatus: 'verified' },
  };
  authState.authMode = 'password';
  authState.isLoading = false;
  authState.needsSetup = false;
  authState.hasCompletedOnboarding = false;
  authState.refreshOnboardingStatus.mockReset();
  policyState.isReadOnly = false;
  policyState.status = 'ready';
});

test('skips the write-oriented onboarding wizard for read-only DingTalk deployments', () => {
  authState.authMode = 'dingtalk';

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('WORKSPACE_SENTINEL'));
  assert.equal(screen.queryByText('ONBOARDING_SENTINEL'), null);
});

test('does not expose local account setup when DingTalk is the server auth mode', () => {
  authState.user = null;
  authState.authMode = 'dingtalk';
  authState.needsSetup = true;

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('LOGIN_SENTINEL'));
  assert.equal(screen.queryByText('SETUP_SENTINEL'), null);
});

test('does not expose local account setup for an unavailable or unknown auth mode', () => {
  authState.user = null;
  authState.needsSetup = true;
  authState.authMode = 'unavailable';

  const view = render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('LOGIN_SENTINEL'));
  assert.equal(screen.queryByText('SETUP_SENTINEL'), null);

  // A malformed/legacy status response must not turn a missing mode into a
  // client-side registration path either.
  authState.authMode = null;
  view.rerender(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );
  assert.ok(screen.getByText('LOGIN_SENTINEL'));
  assert.equal(screen.queryByText('SETUP_SENTINEL'), null);
});

test('keeps first-account setup available for password mode while policy is unauthenticated', () => {
  authState.user = null;
  authState.authMode = 'password';
  authState.needsSetup = true;
  // The policy provider has no authenticated user to query yet and therefore
  // starts from its restrictive fallback. That fallback must not block the
  // server-advertised password bootstrap form.
  policyState.isReadOnly = true;
  policyState.status = 'loading';

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('SETUP_SENTINEL'));
  assert.equal(screen.queryByText('LOGIN_SENTINEL'), null);
});

test('fails closed when legacy platform mode has no resolved managed user', () => {
  authState.user = null;
  authState.authMode = 'platform';
  authState.needsSetup = false;

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('LOGIN_SENTINEL'));
  assert.equal(screen.queryByText('WORKSPACE_SENTINEL'), null);
});

test('skips onboarding for a confirmed product/QA read-only policy', () => {
  policyState.isReadOnly = true;

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('WORKSPACE_SENTINEL'));
  assert.equal(screen.queryByText('ONBOARDING_SENTINEL'), null);
});

test('keeps onboarding for a writable local developer policy', () => {
  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('ONBOARDING_SENTINEL'));
  assert.equal(screen.queryByText('WORKSPACE_SENTINEL'), null);
});

test('waits for the deployment policy before showing password onboarding', () => {
  policyState.status = 'loading';

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('LOADING_SENTINEL'));
  assert.equal(screen.queryByText('ONBOARDING_SENTINEL'), null);
});

test('fails closed to the workspace when policy resolution errors into read-only fallback', () => {
  policyState.status = 'error';
  policyState.isReadOnly = true;

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('WORKSPACE_SENTINEL'));
  assert.equal(screen.queryByText('ONBOARDING_SENTINEL'), null);
});

test('skips onboarding for an unverified enrollment identity even before policy loads', () => {
  authState.authMode = 'password';
  authState.user = {
    id: 2,
    username: '待登记成员',
    actor: { identityStatus: 'pending' },
  };
  policyState.status = 'loading';

  render(
    <ProtectedRoute>
      <span>WORKSPACE_SENTINEL</span>
    </ProtectedRoute>,
  );

  assert.ok(screen.getByText('WORKSPACE_SENTINEL'));
  assert.equal(screen.queryByText('ONBOARDING_SENTINEL'), null);
});
