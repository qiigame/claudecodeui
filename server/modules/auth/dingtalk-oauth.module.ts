import {
  collaborationService,
  identityRegistryService,
} from '@/modules/collaboration/index.js';

import { generateToken } from './auth.middleware.js';
import { AUTH_DEPLOYMENT_MODE } from './auth-policy.js';
import {
  createDingTalkOAuthNonce,
  createDingTalkOAuthService,
} from './dingtalk-oauth.service.js';

const SETTINGS_ADMIN_USER_IDS = process.env.CLOUDCLI_SETTINGS_ADMIN_USER_IDS;

/** Direct DingTalk OAuth service assembled for Auth routes and status. */
export const dingTalkOAuthService = createDingTalkOAuthService({
  credentialsPath: process.env.CLOUDCLI_DINGTALK_CREDENTIALS_FILE,
  publicOrigin: process.env.CLOUDCLI_DINGTALK_PUBLIC_ORIGIN,
  allowInsecureHttpForTests:
    process.env.CLOUDCLI_DINGTALK_ALLOW_INSECURE_HTTP_FOR_TESTS === '1',
  // Resolve the runtime global explicitly.  The backend tsconfig intentionally
  // omits DOM libs, so an unqualified `fetch` is not a declared module symbol
  // even though Node/Bun provide it at runtime.
  fetch: globalThis.fetch,
  now: () => Math.floor(Date.now() / 1000),
  randomNonce: createDingTalkOAuthNonce,
  upsertActor: (input) => collaborationService.upsertDingTalkActor(input),
  generateToken,
  settingsAdminUserIds: SETTINGS_ADMIN_USER_IDS,
  deploymentProfile: AUTH_DEPLOYMENT_MODE.profile,
  requiresDingTalk: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
  resolveRegistryIdentity: (input, options) => identityRegistryService.resolveDingTalkIdentity(input, options),
});

// Do not fail the whole process during module evaluation when a local
// developer machine happens to carry a partial/stale DingTalk environment.
// `AUTH_DEPLOYMENT_MODE` still treats such a declaration as an SSO intent, so
// auth middleware disables password/first-user fallback and requests fail
// closed. Operators can call `assertConfiguration()` from an explicit
// deployment preflight after provisioning the credentials file; normal status
// and login requests surface the 503 configuration error without preventing a
// developer server from starting.
try {
  // A managed SSO process requires the registry even when the operator did
  // not set the legacy `CLOUDCLI_IDENTITY_REGISTRY_REQUIRED` switch.  Keep
  // startup alive so the health/status surface can explain the outage; the
  // OAuth callback and every mutation/execution boundary remain fail-closed.
  identityRegistryService.assertConfiguration({
    required: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
  });
} catch (error) {
  console.warn(
    '[IdentityRegistry] Project identity registry is unavailable; managed mutations remain fail-closed.',
    error instanceof Error ? error.message : String(error),
  );
}

if (AUTH_DEPLOYMENT_MODE.requiresDingTalk
  && !dingTalkOAuthService.getPublicStatus().enabled) {
  console.warn(
    '[DingTalkOAuth] DingTalk authentication is required but unavailable; login remains fail-closed.',
  );
}
