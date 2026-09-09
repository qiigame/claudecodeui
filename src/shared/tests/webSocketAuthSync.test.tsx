import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { establishAuthSession } from '@/shared/authToken';
import { AUTH_TOKEN_STORAGE_KEY } from '@/shared/constants';
import { WebSocketProvider, useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

const authState = vi.hoisted(() => ({
  current: {
    isLoading: false,
    token: 'alice.token.signature',
    user: { id: 1, username: 'alice' },
  },
}));

vi.mock('@/modules/auth', () => ({
  useAuth: () => authState.current,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closeCalls = 0;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  send(message: string) {
    this.sent.push(message);
  }
}

const sockets: FakeWebSocket[] = [];

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <WebSocketProvider>{children}</WebSocketProvider>
);

beforeEach(() => {
  sockets.length = 0;
  localStorage.clear();
  authState.current = {
    isLoading: false,
    token: 'alice.token.signature',
    user: { id: 1, username: 'alice' },
  };
  establishAuthSession(authState.current.token);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a cross-tab token change closes the old socket before reconnecting with the new token', async () => {
  const { result, rerender } = renderHook(() => useWebSocket(), { wrapper });
  await waitFor(() => assert.equal(sockets.length, 1));
  const aliceSocket = sockets[0];
  assert.match(aliceSocket.url, /token=alice\.token\.signature$/);

  act(() => aliceSocket.open());
  assert.equal(result.current.isConnected, true);
  const events: ServerEvent[] = [];
  const unsubscribe = result.current.subscribe((event) => events.push(event));

  act(() => {
    establishAuthSession('bob.token.signature');
    window.dispatchEvent(new StorageEvent('storage', {
      key: AUTH_TOKEN_STORAGE_KEY,
      oldValue: 'alice.token.signature',
      newValue: 'bob.token.signature',
      storageArea: localStorage,
    }));
  });

  assert.equal(aliceSocket.closeCalls, 1, 'the old actor socket closes on the storage event');
  assert.equal(result.current.isConnected, false);
  act(() => result.current.sendMessage({ type: 'must-not-use-alice' }));
  assert.deepEqual(aliceSocket.sent, []);

  authState.current = {
    isLoading: false,
    token: 'bob.token.signature',
    user: { id: 2, username: 'bob' },
  };
  rerender();

  await waitFor(() => assert.equal(sockets.length, 2));
  assert.match(sockets[1].url, /token=bob\.token\.signature$/);
  assert.equal(aliceSocket.closeCalls, 1, 'auth-state cleanup does not close it twice');
  act(() => sockets[1].open());
  assert.equal(
    events.some((event) => 'kind' in event && event.kind === 'websocket_reconnected'),
    false,
    'the new actor\'s first socket is not a reconnect of the previous actor',
  );
  unsubscribe();
});
