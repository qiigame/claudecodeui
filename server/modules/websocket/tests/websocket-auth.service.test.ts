import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasDingTalkActor,
  hasVerifiedDingTalkActor,
  verifyWebSocketClient,
} from '@/modules/websocket/services/websocket-auth.service.js';

function request(url: string, headers: Record<string, string | string[]> = {}) {
  return { url, headers } as never;
}

test('legacy platform bypass is used only when no token is presented', () => {
  const calls: Array<string | null> = [];
  const info = { req: request('/ws'), origin: '', secure: false } as never;
  const accepted = verifyWebSocketClient(info, {
    allowUnauthenticatedPlatform: true,
    authenticateWebSocket: (token) => {
      calls.push(token);
      return { id: 1, username: 'platform-user' };
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(calls, [null]);
});

test('a token takes precedence over legacy platform mode', () => {
  const calls: Array<string | null> = [];
  const info = { req: request('/ws?token=signed-token'), origin: '', secure: false } as never;
  const accepted = verifyWebSocketClient(info, {
    allowUnauthenticatedPlatform: true,
    authenticateWebSocket: (token) => {
      calls.push(token);
      return token === 'signed-token' ? { id: 7, username: 'dingtalk-user' } : null;
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(calls, ['signed-token']);
});

test('SSO deployments reject a websocket without a bearer token', () => {
  const calls: Array<string | null> = [];
  const info = {
    req: request('/ws', { authorization: 'Basic legacy-credentials' }),
    origin: '',
    secure: false,
  } as never;
  const accepted = verifyWebSocketClient(info, {
    allowUnauthenticatedPlatform: false,
    authenticateWebSocket: (token) => {
      calls.push(token);
      return token ? { id: 1, username: 'should-not-be-used' } : null;
    },
  });

  assert.equal(accepted, false);
  assert.deepEqual(calls, []);
});

test('legacy isPlatform presentation flag cannot reopen websocket auth bypass', () => {
  const calls: Array<string | null> = [];
  const info = { req: request('/ws'), origin: '', secure: false } as never;
  const accepted = verifyWebSocketClient(info, {
    // This field is retained for source compatibility but must not be trusted.
    isPlatform: true,
    authenticateWebSocket: (token) => {
      calls.push(token);
      return { id: 1, username: 'must-not-be-used' };
    },
  });

  assert.equal(accepted, false);
  assert.deepEqual(calls, []);
});

test('Authorization header is accepted when query token is absent', () => {
  const calls: Array<string | null> = [];
  const info = {
    req: request('/ws', { authorization: 'Bearer header-token' }),
    origin: '',
    secure: false,
  } as never;
  const accepted = verifyWebSocketClient(info, {
    allowUnauthenticatedPlatform: false,
    authenticateWebSocket: (token) => {
      calls.push(token);
      return { id: 7, username: 'dingtalk-user' };
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(calls, ['header-token']);
});

test('WebSocket Authorization parsing matches REST strictness', () => {
  const cases: Array<{ authorization: string | string[]; query?: string }> = [
    { authorization: 'Bearer jwt-token extra', query: 'valid-query-token' },
    { authorization: 'Bearer jwt-token,other', query: 'valid-query-token' },
    { authorization: 'Bearer jwt:token', query: 'valid-query-token' },
    { authorization: ['Bearer jwt-token', 'Bearer second-token'], query: 'valid-query-token' },
  ];

  for (const candidate of cases) {
    const calls: Array<string | null> = [];
    const info = {
      req: request(
        `/ws?token=${encodeURIComponent(candidate.query ?? '')}`,
        { authorization: candidate.authorization },
      ),
      origin: '',
      secure: false,
    } as never;
    const accepted = verifyWebSocketClient(info, {
      allowUnauthenticatedPlatform: true,
      authenticateWebSocket: (token) => {
        calls.push(token);
        return { id: 7, username: 'must-not-be-used' };
      },
    });

    // A malformed/present Authorization header cannot be bypassed by a query
    // token, and the authenticator must not receive an unsafe token string.
    assert.equal(accepted, false, JSON.stringify(candidate));
    assert.deepEqual(calls, [], JSON.stringify(candidate));
  }
});

test('query credentials use the REST token alphabet and reject duplicates', () => {
  const invalidUrls = [
    '/ws?token=jwt%3Atoken',
    '/ws?token=jwt-token%20extra',
    '/ws?token=',
    '/ws?token=first&token=second',
  ];

  for (const url of invalidUrls) {
    const calls: Array<string | null> = [];
    const info = { req: request(url), origin: '', secure: false } as never;
    const accepted = verifyWebSocketClient(info, {
      allowUnauthenticatedPlatform: true,
      authenticateWebSocket: (token) => {
        calls.push(token);
        return { id: 7, username: 'must-not-be-used' };
      },
    });

    // Explicit malformed query credentials must not fall back to the legacy
    // first-user platform principal.
    assert.equal(accepted, false, url);
    assert.deepEqual(calls, [], url);
  }
});

test('a valid query credential is accepted when no Authorization header exists', () => {
  const calls: Array<string | null> = [];
  const info = {
    req: request('/ws?token=jwt-token'),
    origin: '',
    secure: false,
  } as never;
  const accepted = verifyWebSocketClient(info, {
    allowUnauthenticatedPlatform: false,
    authenticateWebSocket: (token) => {
      calls.push(token);
      return { id: 7, username: 'query-user' };
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(calls, ['jwt-token']);
});

test('managed SSO websocket admits pending or ambiguous DingTalk actors for read subscriptions', () => {
  for (const identityStatus of ['pending', 'ambiguous', 'configured'] as const) {
    const info = {
      req: request('/ws?token=signed-token'),
      origin: '',
      secure: false,
    } as never;
    const user = {
      id: 7,
      username: '待登记',
      actor: {
        provider: 'dingtalk',
        personId: null,
        identityStatus,
      },
    };
    const accepted = verifyWebSocketClient(info, {
      requireVerifiedDingTalkActor: true,
      authenticateWebSocket: () => user,
    });

    assert.equal(accepted, true, identityStatus);
    assert.equal(hasDingTalkActor(user), true);
  }
});

test('actor-presence mode accepts a configured actor without requiring verification at upgrade', () => {
  const info = {
    req: request('/ws?token=signed-token'),
    origin: '',
    secure: false,
  } as never;

  assert.equal(verifyWebSocketClient(info, {
    requireDingTalkActor: true,
    authenticateWebSocket: () => ({
      id: 7,
      actor: { provider: 'dingtalk', identityStatus: 'configured' },
    }),
  }), true);
});

test('managed SSO websocket still rejects a non-DingTalk principal', () => {
  const info = {
    req: request('/ws?token=signed-token'),
    origin: '',
    secure: false,
  } as never;

  assert.equal(verifyWebSocketClient(info, {
    requireDingTalkActor: true,
    authenticateWebSocket: () => ({ id: 7, username: 'local-account' }),
  }), false);
});

test('managed SSO websocket recognizes and admits a verified DingTalk actor', () => {
  const info = {
    req: request('/ws?token=signed-token'),
    origin: '',
    secure: false,
  } as never;
  const user = {
    id: 7,
    username: '已登记',
    actor: {
      provider: 'dingtalk',
      personId: 'person-7',
      identityStatus: 'verified',
    },
  };

  assert.equal(hasVerifiedDingTalkActor(user), true);
  assert.equal(verifyWebSocketClient(info, {
    requireVerifiedDingTalkActor: true,
    authenticateWebSocket: () => user,
  }), true);
});

test('local developer websocket remains compatible with a non-DingTalk principal', () => {
  const info = {
    req: request('/ws?token=signed-token'),
    origin: '',
    secure: false,
  } as never;

  assert.equal(verifyWebSocketClient(info, {
    requireVerifiedDingTalkActor: false,
    authenticateWebSocket: () => ({ id: 7, username: 'local-developer' }),
  }), true);
});
