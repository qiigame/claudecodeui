import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { AUTH_TOKEN_STORAGE_KEY } from '@/shared/constants';

const apiMocks = vi.hoisted(() => ({
  status: vi.fn(),
  dingTalkSession: vi.fn(),
  userForToken: vi.fn(),
  onboardingStatus: vi.fn(),
}));

const hydrationMocks = vi.hoisted(() => ({
  preferences: vi.fn(),
  drafts: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    auth: {
      status: apiMocks.status,
      userForToken: apiMocks.userForToken,
      dingTalkSession: apiMocks.dingTalkSession,
      login: vi.fn(),
      register: vi.fn(),
      refresh: vi.fn(),
    },
    user: {
      onboardingStatus: apiMocks.onboardingStatus,
    },
  },
}));

vi.mock('@/shared/chatDrafts', () => ({
  hydrateChatDrafts: hydrationMocks.drafts,
  resetChatDrafts: vi.fn(),
}));

vi.mock('@/shared/userSettings', () => ({
  hydrateUserPreferences: hydrationMocks.preferences,
  resetUserPreferences: vi.fn(),
}));

const jsonResponse = (payload: unknown, status = 200) => new Response(
  JSON.stringify(payload),
  { status, headers: { 'Content-Type': 'application/json' } },
);

const makeToken = (subject: string) => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: subject, iat: now, exp: now + 600 })}.signature`;
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

const dispatchTokenStorageChange = (oldValue: string | null, newValue: string | null) => {
  if (newValue === null) {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } else {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, newValue);
  }
  window.dispatchEvent(new StorageEvent('storage', {
    key: AUTH_TOKEN_STORAGE_KEY,
    oldValue,
    newValue,
    storageArea: localStorage,
  }));
};

beforeEach(() => {
  localStorage.clear();
  apiMocks.status.mockReset().mockResolvedValue(jsonResponse({ needsSetup: false }));
  apiMocks.dingTalkSession.mockReset().mockResolvedValue(
    jsonResponse({ error: 'No completed DingTalk login is available.' }, 401),
  );
  apiMocks.userForToken.mockReset();
  apiMocks.onboardingStatus.mockReset().mockResolvedValue(
    jsonResponse({ hasCompletedOnboarding: true }),
  );
  hydrationMocks.preferences.mockReset();
  hydrationMocks.drafts.mockReset();
});

test('a DingTalk handoff replaces an existing stored account before it can be restored', async () => {
  const aliceToken = makeToken('alice');
  const bobToken = makeToken('bob');
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, aliceToken);
  apiMocks.status.mockResolvedValue(jsonResponse({
    needsSetup: false,
    dingTalk: {
      enabled: true,
      providers: [{ key: 'company', name: 'Company DingTalk' }],
    },
  }));
  apiMocks.dingTalkSession.mockResolvedValue(jsonResponse({
    token: bobToken,
    user: { id: 2, username: 'bob' },
  }));
  apiMocks.userForToken.mockResolvedValue(
    jsonResponse({ user: { id: 1, username: 'alice' } }),
  );

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'bob'));

  assert.equal(result.current.token, bobToken);
  assert.equal(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY), bobToken);
  assert.equal(apiMocks.dingTalkSession.mock.calls.length, 1);
  assert.equal(
    apiMocks.userForToken.mock.calls.length,
    0,
    'the stale Alice token must never be restored before consuming Bob\'s handoff',
  );
  assert.equal(
    result.current.canManageSettings,
    false,
    'missing permissions must fail closed',
  );
});

test('settings management is granted only by an explicit boolean permission from the auth response', async () => {
  const adminToken = makeToken('admin');
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, adminToken);
  apiMocks.userForToken.mockResolvedValue(jsonResponse({
    user: {
      id: 1,
      username: 'admin',
      permissions: { manageSettings: true },
    },
  }));

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'admin'));

  assert.equal(result.current.canManageSettings, true);
});

test('a truthy non-boolean settings permission still fails closed', async () => {
  const userToken = makeToken('user');
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, userToken);
  apiMocks.userForToken.mockResolvedValue(jsonResponse({
    user: {
      id: 2,
      username: 'user',
      permissions: { manageSettings: 'true' },
    },
  }));

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'user'));

  assert.equal(result.current.canManageSettings, false);
});

test('a missing DingTalk handoff falls back to the existing stored account', async () => {
  const aliceToken = makeToken('alice');
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, aliceToken);
  apiMocks.status.mockResolvedValue(jsonResponse({
    needsSetup: false,
    dingTalk: {
      enabled: true,
      providers: [{ key: 'company', name: 'Company DingTalk' }],
    },
  }));
  apiMocks.userForToken.mockResolvedValue(
    jsonResponse({ user: { id: 1, username: 'alice' } }),
  );

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'alice'));

  assert.equal(result.current.token, aliceToken);
  assert.equal(apiMocks.dingTalkSession.mock.calls.length, 1);
  assert.deepEqual(apiMocks.userForToken.mock.calls[0], [aliceToken]);
});

test('a cross-tab account switch clears the old pair, then commits the new token and user together', async () => {
  const aliceToken = makeToken('alice');
  const bobToken = makeToken('bob');
  const bobResponse = deferred<Response>();
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, aliceToken);
  apiMocks.userForToken.mockImplementation((token: string) => {
    if (token === aliceToken) {
      return Promise.resolve(jsonResponse({ user: { id: 1, username: 'alice' } }));
    }
    return bobResponse.promise;
  });

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'alice'));

  act(() => dispatchTokenStorageChange(aliceToken, bobToken));

  assert.equal(result.current.user, null, 'the previous user must stop rendering immediately');
  assert.equal(result.current.token, null, 'the next token stays inactive until its user is known');
  assert.equal(result.current.isLoading, true);

  await act(async () => {
    bobResponse.resolve(jsonResponse({ user: { id: 2, username: 'bob' } }));
    await bobResponse.promise;
  });
  await waitFor(() => assert.equal(result.current.user?.username, 'bob'));

  assert.equal(result.current.token, bobToken);
  assert.equal(result.current.isLoading, false);
});

test('the latest cross-tab account switch wins when an older user lookup finishes last', async () => {
  const aliceToken = makeToken('alice');
  const bobToken = makeToken('bob');
  const carolToken = makeToken('carol');
  const bobResponse = deferred<Response>();
  const carolResponse = deferred<Response>();
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, aliceToken);
  apiMocks.userForToken.mockImplementation((token: string) => {
    if (token === aliceToken) {
      return Promise.resolve(jsonResponse({ user: { id: 1, username: 'alice' } }));
    }
    return token === bobToken ? bobResponse.promise : carolResponse.promise;
  });

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'alice'));

  act(() => {
    dispatchTokenStorageChange(aliceToken, bobToken);
    dispatchTokenStorageChange(bobToken, carolToken);
  });

  await act(async () => {
    carolResponse.resolve(jsonResponse({ user: { id: 3, username: 'carol' } }));
    await carolResponse.promise;
  });
  await waitFor(() => assert.equal(result.current.user?.username, 'carol'));

  await act(async () => {
    bobResponse.resolve(jsonResponse({ user: { id: 2, username: 'bob' } }));
    await bobResponse.promise;
  });

  assert.equal(result.current.user?.username, 'carol');
  assert.equal(result.current.token, carolToken);
});

test('account switching aborts and invalidates the previous user-data hydration', async () => {
  const aliceToken = makeToken('alice');
  const bobToken = makeToken('bob');
  const bobResponse = deferred<Response>();
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, aliceToken);
  apiMocks.userForToken.mockImplementation((token: string) => {
    if (token === aliceToken) {
      return Promise.resolve(jsonResponse({ user: { id: 1, username: 'alice' } }));
    }
    return bobResponse.promise;
  });

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'alice'));
  await waitFor(() => assert.equal(hydrationMocks.preferences.mock.calls.length, 1));

  const aliceHydration = hydrationMocks.preferences.mock.calls[0][0] as {
    signal: AbortSignal;
    isCurrent: () => boolean;
  };
  act(() => dispatchTokenStorageChange(aliceToken, bobToken));

  assert.equal(aliceHydration.signal.aborted, true);
  assert.equal(aliceHydration.isCurrent(), false);

  await act(async () => {
    bobResponse.resolve(jsonResponse({ user: { id: 2, username: 'bob' } }));
    await bobResponse.promise;
  });
  await waitFor(() => assert.equal(result.current.user?.username, 'bob'));
  await waitFor(() => assert.equal(hydrationMocks.preferences.mock.calls.length, 2));

  const bobHydration = hydrationMocks.preferences.mock.calls[1][0] as {
    signal: AbortSignal;
    isCurrent: () => boolean;
  };
  assert.equal(bobHydration.signal.aborted, false);
  assert.equal(bobHydration.isCurrent(), true);
});

test('a logout in another tab clears both halves of the local session', async () => {
  const aliceToken = makeToken('alice');
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, aliceToken);
  apiMocks.userForToken.mockResolvedValue(
    jsonResponse({ user: { id: 1, username: 'alice' } }),
  );

  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.user?.username, 'alice'));

  act(() => dispatchTokenStorageChange(aliceToken, null));

  assert.equal(result.current.user, null);
  assert.equal(result.current.token, null);
  assert.equal(result.current.isLoading, false);
});
