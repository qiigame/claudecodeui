import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '@/shared/api';
import {
  AUTH_SESSION_EXPIRED_EVENT,
  AUTH_TOKEN_REFRESHED_EVENT,
  clearAuthSession,
  establishAuthSession,
  getAuthSessionSnapshot,
  getAuthTokenRefreshDelay,
  setAuthDeploymentMode,
  isAuthTokenExpired,
  isValidRefreshedToken,
  storeAuthToken,
} from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { AUTH_TOKEN_STORAGE_KEY } from '@/shared/constants';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import type { DingTalkLoginProvider } from '@/shared/types';

/** The signed-in account held by AuthContext - a required `username` plus an optional id and any additional fields the auth API returns - and should be read through `useAuth()` rather than re-derived from raw auth responses. */
type AuthUser = {
  id?: number | string;
  username: string;
  permissions?: {
    manageSettings?: boolean;
  };
  [key: string]: unknown;
};

type AuthSessionState = {
  user: AuthUser | null;
  token: string | null;
};

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
  sessionExpired: 'Your session expired. Please log in again.',
} as const;

type AuthActionResult = { success: true } | { success: false; error: string };

type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

type AuthStatusPayload = {
  needsSetup?: boolean;
  authMode?: {
    mode?: 'platform' | 'dingtalk' | 'password' | 'unavailable';
    requiresLogin?: boolean;
    passwordLoginEnabled?: boolean;
  };
  dingTalk?: {
    enabled?: boolean;
    providers?: DingTalkLoginProvider[];
  };
};

type AuthUserPayload = {
  user?: AuthUser;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type ApiErrorPayload = {
  error?: string;
  message?: string;
};

const AUTH_MODES = new Set<AuthContextValue['authMode']>([
  'platform',
  'dingtalk',
  'password',
  'unavailable',
]);

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  /** Server-authoritative permission. Missing or malformed values fail closed. */
  canManageSettings: boolean;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  dingTalkProviders: DingTalkLoginProvider[];
  /** Server-authoritative auth mode; `platform` means managed upstream auth. */
  authMode: 'platform' | 'dingtalk' | 'password' | 'unavailable' | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  return payload.error ?? payload.message ?? fallback;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  establishAuthSession(token);
};

const clearStoredToken = () => {
  clearAuthSession();
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  // The user and token are one state unit so a tab can never render one
  // account's user together with another account's bearer credential.
  const [authSession, setAuthSession] = useState<AuthSessionState>(() => ({
    user: null,
    token: readStoredToken(),
  }));
  const { user, token } = authSession;
  const canManageSettings = user?.permissions?.manageSettings === true;
  const authSessionRef = useRef(authSession);
  // Every external-token reconciliation owns a generation. A slower response
  // from an earlier account switch is ignored once a newer storage event wins.
  const authSyncGenerationRef = useRef(0);
  // User preferences and drafts are fetched outside the auth request itself.
  // Keep an independent cancellation/ownership fence so a late response from
  // account A cannot hydrate the stores after account B has been committed.
  const userDataHydrationRef = useRef<{
    generation: number;
    controller: AbortController | null;
  }>({ generation: 0, controller: null });
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The server-owned provider list drives the login buttons and is never
  // accepted back as identity; OAuth callback data remains authoritative.
  const [dingTalkProviders, setDingTalkProviders] = useState<DingTalkLoginProvider[]>([]);
  const [authMode, setAuthMode] = useState<AuthContextValue['authMode']>(null);

  const invalidateUserDataHydration = useCallback(() => {
    userDataHydrationRef.current.generation += 1;
    userDataHydrationRef.current.controller?.abort();
    userDataHydrationRef.current.controller = null;
  }, []);

  const getUserKey = useCallback((candidate: AuthUser | null): string | null => (
    candidate ? String(candidate.id ?? candidate.username) : null
  ), []);

  const commitAuthSession = useCallback((nextSession: AuthSessionState) => {
    if (
      authSessionRef.current.token !== nextSession.token
      || getUserKey(authSessionRef.current.user) !== getUserKey(nextSession.user)
    ) {
      invalidateUserDataHydration();
    }
    authSessionRef.current = nextSession;
    setAuthSession(nextSession);
  }, [getUserKey, invalidateUserDataHydration]);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    // A handoff/login can replace an already authenticated account without
    // passing through the logout UI. Clear both stores before exposing the new
    // identity so a stale local mirror can never flash for the new account.
    // During normal page bootstrap the token is unchanged and the user has
    // not been resolved yet; preserve that mirror for first-paint settings.
    const previousSession = authSessionRef.current;
    const replacingKnownIdentity = Boolean(previousSession.user)
      && getUserKey(previousSession.user) !== getUserKey(nextUser);
    const replacingStoredToken = previousSession.token !== null
      && previousSession.token !== nextToken;
    if (replacingKnownIdentity || replacingStoredToken) {
      resetUserPreferences();
      resetChatDrafts();
    }
    authSyncGenerationRef.current += 1;
    commitAuthSession({ user: nextUser, token: nextToken });
    persistToken(nextToken);
  }, [commitAuthSession, getUserKey]);

  const clearSession = useCallback(() => {
    authSyncGenerationRef.current += 1;
    invalidateUserDataHydration();
    commitAuthSession({ user: null, token: null });
    clearStoredToken();
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, [commitAuthSession, invalidateUserDataHydration]);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for. Until this resolves, every reader falls back to the
  // localStorage mirror of the last known server state.
  const userKey = user ? String(user.id ?? user.username) : null;
  const hydrationToken = token;
  useEffect(() => {
    if (!userKey) {
      return;
    }

    const controller = new AbortController();
    const generation = userDataHydrationRef.current.generation + 1;
    userDataHydrationRef.current.generation = generation;
    userDataHydrationRef.current.controller = controller;
    const isCurrent = () => (
      userDataHydrationRef.current.generation === generation
      && !controller.signal.aborted
      && authSessionRef.current.token === hydrationToken
      && getUserKey(authSessionRef.current.user) === userKey
    );

    void hydrateUserPreferences({ signal: controller.signal, isCurrent });
    void hydrateChatDrafts({ signal: controller.signal, isCurrent });

    return () => {
      controller.abort();
      if (userDataHydrationRef.current.controller === controller) {
        userDataHydrationRef.current.controller = null;
        userDataHydrationRef.current.generation += 1;
      }
    };
  }, [getUserKey, hydrationToken, userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const refreshSession = useCallback(async () => {
    if (authMode === 'platform' || !token || !user) {
      return;
    }

    const requestSession = getAuthSessionSnapshot();
    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (isValidRefreshedToken(payload?.token)) {
        // The refresh body belongs to the session that initiated this request.
        // A cross-tab login while it was pending makes this CAS a no-op.
        storeAuthToken(payload.token, requestSession);
      }
    } catch (caughtError) {
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [authMode, token, user]);

  const reconcileStoredSession = useCallback(async (nextToken: string | null) => {
    const currentSession = authSessionRef.current;
    if (nextToken === currentSession.token && currentSession.user) {
      return;
    }

    const generation = authSyncGenerationRef.current + 1;
    authSyncGenerationRef.current = generation;
    invalidateUserDataHydration();

    // Stop authenticated children (including the old account's websocket)
    // before resolving the new token's user. Keeping either half would permit
    // an HTTP request and a chat send to be attributed to different people.
    commitAuthSession({ user: null, token: null });
    resetUserPreferences();
    resetChatDrafts();
    setError(null);

    if (!nextToken || !isValidRefreshedToken(nextToken) || isAuthTokenExpired(nextToken)) {
      if (nextToken && readStoredToken() === nextToken) {
        clearStoredToken();
      }
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const response = await api.auth.userForToken(nextToken);
      const payload = await parseJsonSafely<AuthUserPayload>(response);
      if (
        generation !== authSyncGenerationRef.current
        || readStoredToken() !== nextToken
      ) {
        return;
      }

      if (!response.ok || !payload?.user) {
        clearStoredToken();
        return;
      }

      commitAuthSession({ user: payload.user, token: nextToken });
      setNeedsSetup(false);
      await checkOnboardingStatus();
    } catch (caughtError) {
      if (generation === authSyncGenerationRef.current) {
        console.error('[Auth] Cross-tab session sync failed:', caughtError);
        setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
      }
    } finally {
      if (generation === authSyncGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [checkOnboardingStatus, commitAuthSession, invalidateUserDataHydration]);

  useEffect(() => {
    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<unknown>).detail;
      if (!isValidRefreshedToken(nextToken)) {
        return;
      }

      const currentSession = authSessionRef.current;
      if (currentSession.token === nextToken) {
        return;
      }
      if (currentSession.user) {
        // A response-authenticated refresh cannot change the account, so keep
        // the existing user and rotate both halves as one session update.
        authSyncGenerationRef.current += 1;
        commitAuthSession({ user: currentSession.user, token: nextToken });
        return;
      }
      void reconcileStoredSession(nextToken);
    };
    const handleSessionExpired = () => {
      clearSession();
      setError(AUTH_ERROR_MESSAGES.sessionExpired);
      setIsLoading(false);
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== AUTH_TOKEN_STORAGE_KEY
        || (event.storageArea && event.storageArea !== localStorage)
      ) {
        return;
      }
      // Storage events may queue (logout followed immediately by login), so
      // reconcile the current persisted token rather than the stale payload.
      void reconcileStoredSession(readStoredToken());
    };

    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
      window.removeEventListener('storage', handleStorage);
    };
  }, [clearSession, commitAuthSession, reconcileStoredSession]);

  const checkAuthStatus = useCallback(async () => {
    const generation = authSyncGenerationRef.current;
    const initialToken = authSessionRef.current.token;
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      if (!statusResponse.ok) {
        setAuthDeploymentMode('unavailable');
        setAuthMode('unavailable');
        setDingTalkProviders([]);
        throw new Error(`Authentication status request failed (${statusResponse.status}).`);
      }
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);
      const reportedAuthMode = statusPayload?.authMode?.mode;
      // JSON payloads are runtime input despite the compile-time response
      // type. Missing/unknown modes must not make LoginForm expose a password
      // fallback that the managed server never authorized.
      const nextAuthMode = AUTH_MODES.has(reportedAuthMode ?? null)
        ? reportedAuthMode ?? 'unavailable'
        : 'unavailable';
      // The server, rather than the build-time hosting flag, owns this
      // decision. URL-only transports read the same snapshot from authToken.
      setAuthDeploymentMode(nextAuthMode);
      setAuthMode(nextAuthMode);
      const availableDingTalkProviders = statusPayload?.dingTalk?.enabled === true
        && Array.isArray(statusPayload.dingTalk.providers)
        ? statusPayload.dingTalk.providers.filter((provider): provider is DingTalkLoginProvider => (
          Boolean(provider)
          && typeof provider.key === 'string'
          && provider.key.trim().length > 0
          && typeof provider.name === 'string'
          && provider.name.trim().length > 0
        ))
        : [];
      setDingTalkProviders(availableDingTalkProviders);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      // A legacy hosted deployment may deliberately have no browser JWT, but
      // it must still be represented as an unauthenticated *UI* session. Do
      // not synthesize a `platform-user`: doing so hides a stale local token
      // and makes the browser appear authenticated to code that needs a real
      // DingTalk actor. The server policy handles the managed principal.
      if (nextAuthMode === 'platform') {
        // Clear the browser token without advancing the login generation: this
        // status request is still the active generation, and advancing it here
        // would make the `finally` loading guard discard the result.
        if (authSessionRef.current.user || authSessionRef.current.token) {
          commitAuthSession({ user: null, token: null });
          clearStoredToken();
          resetUserPreferences();
          resetChatDrafts();
        }
        const managedUserResponse = await api.auth.managedUser();
        const managedUserPayload = await parseJsonSafely<AuthUserPayload>(managedUserResponse);
        // A platform lookup can overlap a cross-tab login/logout.  Never let
        // the stale managed principal replace the newer auth session that
        // advanced the generation while this request was in flight.
        if (generation !== authSyncGenerationRef.current) {
          return;
        }
        if (managedUserResponse.ok && managedUserPayload?.user) {
          commitAuthSession({ user: managedUserPayload.user, token: null });
        } else if (!managedUserResponse.ok) {
          throw new Error(`Managed platform user lookup failed (${managedUserResponse.status}).`);
        }
        await checkOnboardingStatus();
        setIsLoading(false);
        return;
      }

      // A completed OAuth callback is a newer, explicit login intent than a
      // JWT left in localStorage. Consume its one-time HttpOnly handoff first;
      // only a confirmed "no handoff" response may fall back to that old JWT.
      if (availableDingTalkProviders.length > 0) {
        const sessionResponse = await api.auth.dingTalkSession();
        if (sessionResponse.ok) {
          const sessionPayload = await parseJsonSafely<AuthSessionPayload>(sessionResponse);
          if (!sessionPayload?.token || !sessionPayload.user) {
            throw new Error('DingTalk session handoff returned an invalid payload.');
          }
          setSession(sessionPayload.user, sessionPayload.token);
          const committedGeneration = authSyncGenerationRef.current;
          await checkOnboardingStatus();
          if (committedGeneration === authSyncGenerationRef.current) {
            setIsLoading(false);
          }
          return;
        }
        if (sessionResponse.status !== 401) {
          throw new Error(`DingTalk session handoff failed (${sessionResponse.status}).`);
        }
      }

      if (!initialToken) {
        return;
      }

      const userResponse = await api.auth.userForToken(initialToken);
      if (
        generation !== authSyncGenerationRef.current
        || readStoredToken() !== initialToken
      ) {
        return;
      }
      if (!userResponse.ok) {
        clearSession();
        setIsLoading(false);
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        setIsLoading(false);
        return;
      }

      commitAuthSession({ user: userPayload.user, token: initialToken });
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      if (generation === authSyncGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [checkOnboardingStatus, clearSession, commitAuthSession, setSession]);

  useEffect(() => {
    // Always ask the server. `VITE_IS_PLATFORM` is a presentation/build flag
    // and must never grant a client-side authentication bypass.
    void checkAuthStatus();
  }, [checkAuthStatus]);

  useEffect(() => {
    if (authMode === 'platform' || !token || !user) {
      return undefined;
    }

    const refreshIfNeeded = () => {
      const refreshDelay = getAuthTokenRefreshDelay(token);
      if (refreshDelay !== null && refreshDelay <= 0) {
        void refreshSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfNeeded();
      }
    };

    const refreshDelay = getAuthTokenRefreshDelay(token);
    const refreshTimer = refreshDelay === null
      ? null
      : window.setTimeout(() => void refreshSession(), refreshDelay);

    window.addEventListener('focus', refreshIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener('focus', refreshIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authMode, refreshSession, token, user]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const logout = useCallback(() => {
    // JWT logout is client-side: the server endpoint does not maintain a
    // revocation list, so clearing the session is the complete operation.
    clearSession();
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      canManageSettings,
      authMode,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      dingTalkProviders,
      login,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      canManageSettings,
      authMode,
      error,
      dingTalkProviders,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
