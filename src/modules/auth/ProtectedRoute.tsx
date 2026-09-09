import type { ReactNode } from 'react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import IdentityAccessNotice from '@/modules/auth/IdentityAccessNotice';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';
import { useDeploymentPolicy } from '@/shared/context/DeploymentPolicyContext';

type ProtectedRouteProps = {
  children: ReactNode;
};

/**
 * A DingTalk actor that has not completed project-identity verification must
 * not be sent through the legacy onboarding wizard: its first step writes a
 * Git identity and the server intentionally rejects that mutation.  Keep the
 * check local to the auth gate so the rest of the workspace can still render
 * the read-only enrollment notice.
 */
const hasUnverifiedEnrollmentIdentity = (user: unknown): boolean => {
  if (!user || typeof user !== 'object') {
    return false;
  }

  const actor = (user as { actor?: { identityStatus?: unknown } }).actor;
  return actor?.identityStatus === 'configured'
    || actor?.identityStatus === 'pending'
    || actor?.identityStatus === 'ambiguous';
};

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const {
    user,
    authMode,
    isLoading,
    needsSetup,
    hasCompletedOnboarding,
    refreshOnboardingStatus,
  } = useAuth();
  const { isReadOnly: deploymentIsReadOnly, status: deploymentPolicyStatus } = useDeploymentPolicy();
  const authenticatedWorkspace = (
    <>
      <IdentityAccessNotice />
      {children}
    </>
  );
  // The product/QA deployment deliberately has no Git, provider-config, or
  // other onboarding write capability.  Do not send its users through the
  // legacy wizard: both steps would either fail with a 403 or encourage them
  // to enter developer credentials.  Password-based local developer builds
  // opt into the writable fallback explicitly; DingTalk deployments are known
  // read-only from the server auth mode and can skip immediately while the
  // capability document is loading.
  // A missing policy must fail closed too.  The policy context starts with a
  // restrictive read-only snapshot while the server document is loading and
  // returns to that snapshot on an error.  Rendering the legacy wizard during
  // either window would briefly encourage Git/provider writes which the server
  // will reject (and can leave a confusing 403 after the user clicks Next).
  // Explicit local developer builds opt into the writable fallback through
  // VITE_DEPLOYMENT_PROFILE=developer, so this does not take the onboarding
  // path away from local developers.
  const skipOnboarding = authMode === 'dingtalk'
    || authMode === 'platform'
    || deploymentIsReadOnly;

  const hasRestrictedEnrollmentIdentity = hasUnverifiedEnrollmentIdentity(user);

  // Avoid a one-frame onboarding flash while a password session's deployment
  // policy is being resolved.  DingTalk and enrollment identities intentionally
  // skip this wait: they are already prohibited from the write-oriented wizard
  // and should reach the read-only notice immediately.
  const waitForDeploymentPolicy = Boolean(user)
    && !hasCompletedOnboarding
    && deploymentPolicyStatus === 'loading'
    && authMode !== 'dingtalk'
    && authMode !== 'platform'
    && !hasRestrictedEnrollmentIdentity;

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  // Only the server-advertised legacy platform mode can omit a browser user.
  // The build-time `VITE_IS_PLATFORM` flag is deliberately not consulted.
  if (authMode === 'platform') {
    // `AuthContext` normally resolves a managed synthetic user for this mode.
    // A malformed/empty 200 response must not turn the platform branch into an
    // authentication bypass; keep the route behind the login surface until a
    // concrete principal is available.
    if (!user) {
      return <LoginForm />;
    }

    if (!skipOnboarding && !hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return authenticatedWorkspace;
  }

  if (needsSetup) {
    // A first-run setup form creates a local password account.  It is not a
    // valid onboarding path for DingTalk-only or product/QA deployments: the
    // former must wait for the configured SSO provider and the latter is
    // intentionally read-only.  An unavailable or unknown mode is also not a
    // positive declaration that local registration is allowed; fail closed to
    // the login surface rather than inviting a user to create a bypass account.
    // `DeploymentPolicyProvider` intentionally has no authenticated policy to
    // fetch before the first account exists, so its fail-closed default is
    // read-only during this branch.  The server's auth mode is the trusted
    // source for whether the initial password account may be created; a
    // managed/product deployment reports `dingtalk`/`unavailable` and is
    // rejected above, while a password deployment must retain SetupForm.
    if (authMode !== 'password') {
      return <LoginForm />;
    }
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (waitForDeploymentPolicy) {
    return <AuthLoadingScreen />;
  }

  // Enrollment identities are authenticated principals, but they are not
  // allowed to write Git configuration or complete onboarding.  Showing the
  // workspace here lets them inspect the project and gives the notice dialog
  // an actionable place to explain how to request access.
  if (skipOnboarding || hasRestrictedEnrollmentIdentity) {
    return authenticatedWorkspace;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return authenticatedWorkspace;
}
