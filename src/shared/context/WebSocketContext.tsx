import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import {
  expireAuthSession,
  getAuthSessionSnapshot,
  isAuthTokenExpired,
  isCurrentAuthSession,
} from '@/shared/authToken';
import { AUTH_TOKEN_STORAGE_KEY } from '@/shared/constants';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (
  token: string | null,
  authMode: 'platform' | 'dingtalk' | 'password' | 'unavailable' | null | undefined,
) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (authMode === 'platform') return `${protocol}//${window.location.host}/ws`;
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const principalEpochRef = useRef<string | null>(null);
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { authMode, isLoading: isAuthLoading, token, user } = useAuth();

  const closeActiveSocket = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const activeSocket = wsRef.current;
    if (!activeSocket) {
      return;
    }

    // Detach reconnect handlers before closing a socket authenticated as the
    // previous account. Only the auth-state effect may open its replacement.
    activeSocket.onopen = null;
    activeSocket.onmessage = null;
    activeSocket.onclose = null;
    activeSocket.onerror = null;
    activeSocket.close();
    wsRef.current = null;
    setIsConnected(false);
  }, []);

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (isAuthLoading || (!user && authMode !== 'platform')) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token, authMode);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');
      const connectionSession = getAuthSessionSnapshot();
      if (authMode !== 'platform' && connectionSession.token !== token) {
        return;
      }
      if (
        principalEpochRef.current !== null
        && principalEpochRef.current !== connectionSession.epoch
      ) {
        // A new login is a new principal, not a reconnect of the previous
        // principal. Consumers must not run old-session catch-up behavior.
        hasConnectedRef.current = false;
      }
      principalEpochRef.current = connectionSession.epoch;

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        if (
          wsRef.current !== websocket
          || (authMode !== 'platform' && !isCurrentAuthSession(connectionSession))
        ) {
          websocket.close();
          return;
        }
        setIsConnected(true);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (
          wsRef.current !== websocket
          || (authMode !== 'platform' && !isCurrentAuthSession(connectionSession))
        ) {
          return;
        }
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;

        if (authMode !== 'platform' && !isCurrentAuthSession(connectionSession)) {
          return;
        }

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          if (authMode !== 'platform' && !isCurrentAuthSession(connectionSession)) return;
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [authMode, dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  useEffect(() => {
    const handleAuthStorageChange = (event: StorageEvent) => {
      if (
        event.key === AUTH_TOKEN_STORAGE_KEY
        && (!event.storageArea || event.storageArea === localStorage)
        && event.newValue !== token
      ) {
        // A storage event arrives before AuthContext finishes resolving the new
        // account. Close now so no click can send over the old account's socket
        // while authenticatedFetch already observes the new stored token.
        closeActiveSocket();
      }
    };

    window.addEventListener('storage', handleAuthStorageChange);
    return () => window.removeEventListener('storage', handleAuthStorageChange);
  }, [closeActiveSocket, token]);

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user, authMode] and `dispatch` is stable, so depending on it reconnects on
  // the same transitions as the authenticated principal changes.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (isAuthLoading || (!user && authMode !== 'platform')) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      closeActiveSocket();
    };
  }, [authMode, closeActiveSocket, connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected
  }), [sendMessage, subscribe, isConnected]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
