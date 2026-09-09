/**
 * The client's half of the JWT session: parsing, expiry, storage and the two
 * events the auth context listens to.
 *
 * Extracted from api.ts, which is meant to be the endpoint map plus its request
 * helpers. This is the security-sensitive part and it is what WebSocketContext,
 * AuthContext, the shell socket and the file-tree uploader actually import.
 */

import {
  AUTH_SESSION_EPOCH_STORAGE_KEY,
  AUTH_TOKEN_STORAGE_KEY,
} from '@/shared/constants';

export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

/**
 * Authentication mode advertised by the server at runtime.  The build-time
 * `VITE_IS_PLATFORM` flag describes presentation/hosting, not whether a
 * browser may bypass authentication.  Keeping this small snapshot here lets
 * URL-only transports (the shell EventSource/WebSocket helpers) follow the
 * server's decision without inventing a fake user in React state.
 */
export type ClientAuthMode = 'platform' | 'dingtalk' | 'password' | 'unavailable' | null;

let authDeploymentMode: ClientAuthMode = null;

export const setAuthDeploymentMode = (mode: unknown): void => {
  authDeploymentMode = mode === 'platform'
    || mode === 'dingtalk'
    || mode === 'password'
    || mode === 'unavailable'
    ? mode
    : null;
};

export const getAuthDeploymentMode = (): ClientAuthMode => authDeploymentMode;

export const isLegacyPlatformAuth = (): boolean => authDeploymentMode === 'platform';

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
export const isValidRefreshedToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

type TokenClaims = {
  issuedAt: number;
  expiresAt: number;
};

const readTokenClaims = (token: unknown): TokenClaims | null => {
  if (!isValidRefreshedToken(token)) {
    return null;
  }

  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(
      encodedPayload.length + ((4 - (encodedPayload.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(atob(paddedPayload)) as { iat?: unknown; exp?: unknown };

    if (
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      return null;
    }

    return { issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
};

// Tolerance for client/server clock skew. The server's own jwt.verify is the
// real authority; this check only decides whether the client should discard a
// token locally. Without an allowance, a browser clock running slightly ahead
// reads a still-server-valid token as expired and drops the session.
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

let authEpochSequence = 0;

const createAuthSessionEpoch = (): string => {
  authEpochSequence += 1;
  // The epoch is a race discriminator, not a secret. Avoid randomUUID because
  // older WebViews used by self-hosted installs do not implement it.
  return `${Date.now().toString(36)}-${authEpochSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const readAuthSessionSnapshot = () => {
  let epoch = localStorage.getItem(AUTH_SESSION_EPOCH_STORAGE_KEY);
  if (!epoch) {
    epoch = createAuthSessionEpoch();
    localStorage.setItem(AUTH_SESSION_EPOCH_STORAGE_KEY, epoch);
  }
  return {
    token: localStorage.getItem(AUTH_TOKEN_STORAGE_KEY),
    epoch,
  } as const;
};

/** Captures the token and login lifetime that an authenticated request belongs to. */
export const getAuthSessionSnapshot = () => readAuthSessionSnapshot();

/** True while no explicit login/logout has replaced the captured login lifetime. */
export const isCurrentAuthSession = (
  snapshot: ReturnType<typeof getAuthSessionSnapshot>,
): boolean => readAuthSessionSnapshot().epoch === snapshot.epoch;

export const isAuthTokenExpired = (token: unknown): boolean => {
  const claims = readTokenClaims(token);
  return claims ? Date.now() >= claims.expiresAt + TOKEN_EXPIRY_SKEW_MS : false;
};

export const getAuthTokenRefreshDelay = (token: unknown): number | null => {
  const claims = readTokenClaims(token);
  if (!claims) {
    return null;
  }

  const refreshAt = claims.issuedAt + ((claims.expiresAt - claims.issuedAt) / 2);
  return Math.max(0, refreshAt - Date.now());
};

const matchesSnapshot = (
  current: ReturnType<typeof getAuthSessionSnapshot>,
  expected?: ReturnType<typeof getAuthSessionSnapshot>,
): boolean => !expected || (
  current.epoch === expected.epoch
  && current.token === expected.token
);

const removeAuthSession = (
  expected?: ReturnType<typeof getAuthSessionSnapshot>,
): boolean => {
  const current = readAuthSessionSnapshot();
  if (!matchesSnapshot(current, expected)) {
    return false;
  }
  localStorage.setItem(AUTH_SESSION_EPOCH_STORAGE_KEY, createAuthSessionEpoch());
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  return true;
};

/** Ends the current session only if it is still the request's captured session. */
export const expireAuthSession = (
  expected?: ReturnType<typeof getAuthSessionSnapshot>,
): boolean => {
  if (!removeAuthSession(expected)) {
    return false;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  }
  return true;
};

/** Explicitly logs out the current browser tab and starts a new empty session lifetime. */
export const clearAuthSession = (): void => {
  removeAuthSession();
};

export const getStoredAuthToken = (): string | null => {
  const snapshot = readAuthSessionSnapshot();
  const { token } = snapshot;
  if (token && isAuthTokenExpired(token)) {
    expireAuthSession(snapshot);
    return null;
  }
  return token;
};

export const storeAuthToken = (
  token: unknown,
  expected?: ReturnType<typeof getAuthSessionSnapshot>,
): boolean => {
  if (!isValidRefreshedToken(token)) {
    return false;
  }

  const current = readAuthSessionSnapshot();
  if (!matchesSnapshot(current, expected)) {
    return false;
  }
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
  }
  return true;
};

/** Installs a login/register/OAuth token under a fresh session lifetime. */
export const establishAuthSession = (token: unknown): boolean => {
  if (!isValidRefreshedToken(token)) {
    return false;
  }

  localStorage.setItem(AUTH_SESSION_EPOCH_STORAGE_KEY, createAuthSessionEpoch());
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
  }
  return true;
};
