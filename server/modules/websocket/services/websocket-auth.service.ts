import type { VerifyClientCallbackSync } from 'ws';

import {
  extractBearerToken,
  extractBearerTokenFromQuery,
} from '@/shared/bearer-token.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

/**
 * Query-string credentials do not carry an authentication scheme, but they
 * must use the same RFC 6750 b64token alphabet as the REST Authorization
 * header.  Reusing `extractBearerToken` keeps the two transports from
 * accepting different token shapes (for example a value containing a comma
 * or a second whitespace-delimited credential).
 */
type WebSocketAuthDependencies = {
  /**
   * Allows the legacy hosted deployment to resolve its upstream-authenticated
   * principal without a CloudCLI JWT. This must come from the server auth
   * policy, not directly from the broad `VITE_IS_PLATFORM` UI flag.
   */
  allowUnauthenticatedPlatform?: boolean;
  /**
   * @deprecated Kept only as a source-compatible marker for older adapters.
   * It is intentionally ignored; callers must inject the server-resolved
   * `allowUnauthenticatedPlatform` decision instead of forwarding
   * `VITE_IS_PLATFORM`.
   */
  isPlatform?: boolean;
  /**
   * Managed DingTalk/SSO deployments require a DingTalk actor before a socket
   * is admitted. The actor may still be pending/ambiguous; execution handlers
   * use `requireVerifiedDingTalkActor` as their stronger per-message gate.
   */
  requireDingTalkActor?: boolean;
  /**
   * @deprecated Compatibility alias for callers that used the old name. It
   * now controls the managed execution gate and also implies the transport
   * actor-presence requirement, but no longer rejects pending identities.
   */
  requireVerifiedDingTalkActor?: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    actor?: {
      provider?: unknown;
      personId?: unknown;
      identityStatus?: unknown;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
};

/**
 * Returns whether a websocket principal carries a DingTalk actor at all.
 *
 * This is the transport-level SSO check. It intentionally does not require
 * `identityStatus === 'verified'`: a first-login `pending`/`ambiguous` actor
 * must be able to open the chat socket to read sessions and see the enrollment
 * prompt. Message handlers apply the stronger verified check immediately
 * before any provider, PTY, approval, or plugin operation.
 */
export function hasDingTalkActor(user: unknown): boolean {
  if (!user || typeof user !== 'object') {
    return false;
  }

  const actor = (user as { actor?: unknown }).actor;
  if (!actor || typeof actor !== 'object') {
    return false;
  }

  return (actor as Record<string, unknown>).provider === 'dingtalk';
}

/**
 * Returns whether a websocket principal is backed by the trusted, verified
 * DingTalk project identity. Pending or ambiguous first-login actors are
 * deliberately false and are gated at operation boundaries rather than at
 * the socket upgrade, so read-only session subscriptions remain available.
 */
export function hasVerifiedDingTalkActor(user: unknown): boolean {
  if (!user || typeof user !== 'object') {
    return false;
  }

  const actor = (user as { actor?: unknown }).actor;
  if (!actor || typeof actor !== 'object') {
    return false;
  }

  const record = actor as Record<string, unknown>;
  const personId = record.personId;
  return record.provider === 'dingtalk'
    && record.identityStatus === 'verified'
    && ((typeof personId === 'string' && personId.trim().length > 0)
      || (typeof personId === 'number' && Number.isSafeInteger(personId) && personId > 0));
}

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  // `ws`' VerifyClientInfo is intentionally generic/unknown in some @types
  // releases; narrow through unknown before applying our request augmentation.
  const request = info.req as unknown as AuthenticatedWebSocketRequest;
  let upgradeUrl: URL;
  try {
    upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    // `ws` normally receives an already parsed HTTP request URL, but a
    // malformed upgrade must never escape the verify-client boundary as an
    // exception (which can leave the HTTP upgrade in an indeterminate state).
    console.log('[WARN] WebSocket authentication failed: malformed upgrade URL');
    return false;
  }
  // Do not log the query string at all.  `token` is the documented credential,
  // but a rejected/legacy client can still send aliases such as
  // `access_token`, `api_key`, or `password`; keeping only the pathname makes
  // the diagnostic useful without relying on an ever-growing sensitive-key
  // denylist (and avoids leaking future query credentials to access logs).
  console.log('WebSocket connection attempt to:', upgradeUrl.pathname);

  // Never fall back to the legacy `isPlatform` field. A broad UI/build flag
  // must not become an authentication bypass merely because an older caller
  // still supplies that property.
  const allowUnauthenticatedPlatform = dependencies.allowUnauthenticatedPlatform === true;
  const requireDingTalkActor = dependencies.requireDingTalkActor === true
    || dependencies.requireVerifiedDingTalkActor === true;

  // Keep credential precedence and malformed-header behavior aligned with the
  // REST middleware.  If an Authorization header is present, it is the sole
  // credential source: a malformed/duplicated header must not be bypassed by
  // adding a valid query token.  Query credentials are accepted only when the
  // header is absent, and duplicate/empty/invalid values fail closed.
  const rawAuthorization = request.headers?.authorization;
  const hasAuthorizationHeader = rawAuthorization !== undefined;
  const headerToken = extractBearerToken(rawAuthorization);
  const queryTokens = upgradeUrl.searchParams.getAll('token');
  const hasQueryCredential = queryTokens.length > 0;
  const queryToken = queryTokens.length === 1
    ? extractBearerTokenFromQuery(queryTokens[0] ?? null)
    : null;
  const token = hasAuthorizationHeader ? headerToken : queryToken;
  const credentialPresented = hasAuthorizationHeader || hasQueryCredential;

  // Do not even invoke the authenticator without a token unless the explicit
  // legacy platform-auth policy opted into the first-user principal. This is
  // important because the production authenticator itself retains a legacy
  // fallback for standalone callers.
  if (!token && (!allowUnauthenticatedPlatform || credentialPresented)) {
    console.log('[WARN] WebSocket authentication failed: token required');
    return false;
  }

  // Only the explicit legacy platform-auth policy may use the first DB user.
  if (!token && allowUnauthenticatedPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    if (requireDingTalkActor && !hasDingTalkActor(user)) {
      console.log('[WARN] WebSocket authentication failed: DingTalk identity required');
      return false;
    }
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  const user = dependencies.authenticateWebSocket(token);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  if (requireDingTalkActor && !hasDingTalkActor(user)) {
    console.log('[WARN] WebSocket authentication failed: DingTalk identity required');
    return false;
  }
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}
