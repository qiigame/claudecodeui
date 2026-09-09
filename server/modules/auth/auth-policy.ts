import {
  parseDeploymentPolicy,
  type DeploymentEnvironment,
  type DeploymentProfile,
} from '@/modules/deployment-policy/index.js';
import { extractBearerToken } from '@/shared/bearer-token.js';

// Re-export the parser from the auth policy's historical public surface. REST
// middleware and external embedders already import this symbol from here;
// keeping the alias avoids an API break while WebSocket auth can use the
// dependency-light shared implementation directly.
export { extractBearerToken } from '@/shared/bearer-token.js';

/**
 * Authentication mode selected at the trusted server configuration boundary.
 * `platform` is the legacy managed deployment mode where an upstream proxy
 * owns identity; every other mode requires a server-issued session token.
 */
export type AuthDeploymentMode = {
  profile: DeploymentProfile;
  dingtalkConfigured: boolean;
  requiresDingTalk: boolean;
  platformBypass: boolean;
  passwordLoginEnabled: boolean;
  mode: 'platform' | 'dingtalk' | 'password' | 'unavailable';
};

const truthy = (value: string | undefined): boolean =>
  ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/**
 * Resolves authentication behavior once from deployment-owned environment
 * variables. A partial DingTalk declaration is treated as an SSO intent so a
 * broken setup cannot silently reopen local-password access.
 */
export function resolveAuthDeploymentMode(
  environment: DeploymentEnvironment = process.env,
): AuthDeploymentMode {
  const policy = parseDeploymentPolicy(environment);
  const dingtalkConfigured = Boolean(
    environment.CLOUDCLI_DINGTALK_CREDENTIALS_FILE?.trim()
      || environment.CLOUDCLI_DINGTALK_PUBLIC_ORIGIN?.trim(),
  );
  const requiresDingTalk = dingtalkConfigured
    || policy.profile === 'product-qa-readonly'
    || truthy(environment.CLOUDCLI_REQUIRE_DINGTALK_AUTH);
  // `VITE_IS_PLATFORM` is a build/presentation hint and must never by itself
  // grant an authentication bypass. `parseDeploymentPolicy` may use the
  // legacy hint only while selecting a profile when no explicit profile is
  // present; after that selection, the profile is the trusted server-side
  // authority. This prevents a stale browser flag in a developer deployment
  // from silently authenticating every request as the first database user.
  // Only the explicit legacy `platform` profile may resolve the first
  // database user without a token.  `production` is a capability profile,
  // not proof that an upstream identity proxy is present; treating it as a
  // bypass would let a typo in deployment wiring expose the first account.
  const platformBypass = policy.profile === 'platform' && !requiresDingTalk;
  const passwordLoginEnabled = !platformBypass && !requiresDingTalk;

  return {
    profile: policy.profile,
    dingtalkConfigured,
    requiresDingTalk,
    platformBypass,
    passwordLoginEnabled,
    mode: platformBypass
      ? 'platform'
      : requiresDingTalk
        ? 'dingtalk'
        : passwordLoginEnabled
          ? 'password'
          : 'unavailable',
  };
}

/** Startup snapshot used by auth middleware and the composition root. */
export const AUTH_DEPLOYMENT_MODE = resolveAuthDeploymentMode();
