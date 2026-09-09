import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ScheduledMessage } from '@/shared/types';

/**
 * The messages queued to be sent to one session later.
 *
 * Scheduling is a server-side timer, so this is a plain fetch rather than
 * anything realtime: the list changes only when this client schedules or
 * cancels something, and it is refetched when the session is reopened.
 */
type UseScheduledMessagesOptions = {
  /** Server-authorized ability to enqueue or cancel a future provider run. */
  canSchedule?: boolean;
};

type ScheduledMessagesState = {
  scope: ScheduledMessagesScope | null;
  messages: ScheduledMessage[];
};

type ScheduledMessagesScope = {
  key: string | null;
  epoch: number;
};

export function useScheduledMessages(
  sessionId: string | null,
  // Omitted server capability state is denied by default. ChatInterface
  // supplies the explicit value for writable developer sessions.
  { canSchedule = false }: UseScheduledMessagesOptions = {},
) {
  const scopeKey = canSchedule && sessionId ? sessionId : null;
  const scopeRef = useRef<ScheduledMessagesScope>({ key: scopeKey, epoch: 0 });
  if (scopeRef.current.key !== scopeKey) {
    // A new object makes A -> B -> A a new lifetime even though the string key
    // eventually repeats; late work from the first A must never touch the last.
    scopeRef.current = {
      key: scopeKey,
      epoch: scopeRef.current.epoch + 1,
    };
  }
  const scope = scopeRef.current;
  const requestGenerationRef = useRef(0);
  const activeListRequestRef = useRef<AbortController | null>(null);
  // Keep the list tagged with the session/capability lifetime so a render that
  // switches sessions never briefly displays the previous session's entries.
  const [scheduledState, setScheduledState] = useState<ScheduledMessagesState>({
    scope: null,
    messages: [],
  });

  const refresh = useCallback(async () => {
    // A refresh function retained by an old render must not cancel or replace
    // a request belonging to the current session.
    if (scopeRef.current !== scope) {
      return;
    }

    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    activeListRequestRef.current?.abort();
    activeListRequestRef.current = null;

    if (!scopeKey) {
      setScheduledState({ scope: null, messages: [] });
      return;
    }

    const controller = new AbortController();
    activeListRequestRef.current = controller;

    try {
      const response = await api.scheduledMessages.list(scopeKey, {
        signal: controller.signal,
      });
      const payload = await response.json();
      if (
        controller.signal.aborted
        || requestGenerationRef.current !== generation
        || scopeRef.current !== scope
        || activeListRequestRef.current !== controller
      ) {
        return;
      }
      setScheduledState({
        scope,
        messages: Array.isArray(payload?.data) ? payload.data : [],
      });
    } catch (error) {
      if (
        controller.signal.aborted
        || requestGenerationRef.current !== generation
        || scopeRef.current !== scope
        || activeListRequestRef.current !== controller
      ) {
        return;
      }
      console.error('Failed to load scheduled messages:', error);
    } finally {
      if (activeListRequestRef.current === controller) {
        activeListRequestRef.current = null;
      }
    }
  }, [scope, scopeKey]);

  // Cleared during the switch render, not by the fetch that follows: the
  // previous session's banner must never paint over the new session, not even
  // for the frame before an effect could run.
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setScheduledMessages([]);
  }

  useEffect(() => {
    activeSessionRef.current = sessionId;
    void refresh();
    return () => {
      requestGenerationRef.current += 1;
      activeListRequestRef.current?.abort();
      activeListRequestRef.current = null;
    };
  }, [refresh]);

  const schedule = useCallback(async (input: {
    content: string;
    scheduledFor: Date;
    options?: Record<string, unknown>;
  }) => {
    if (!scopeKey || scopeRef.current !== scope) return false;

    try {
      const response = await api.scheduledMessages.create({
        sessionId: scopeKey,
        content: input.content,
        scheduledFor: input.scheduledFor.toISOString(),
        options: input.options,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      // The mutation may have succeeded while the user navigated away. Do not
      // refresh the new session or report success to a composer that could
      // otherwise clear its newly entered text.
      if (scopeRef.current !== scope) {
        return false;
      }
      await refresh();
      return scopeRef.current === scope;
    } catch (error) {
      console.error('Failed to schedule message:', error);
      return false;
    }
  }, [refresh, scope, scopeKey]);

  const cancel = useCallback(async (id: string) => {
    if (!scopeKey || scopeRef.current !== scope) return;

    try {
      await api.scheduledMessages.cancel(id);
    } catch (error) {
      console.error('Failed to cancel scheduled message:', error);
    }
    if (scopeRef.current === scope) {
      await refresh();
    }
  }, [refresh, scope, scopeKey]);

  const scheduledMessages = scheduledState.scope === scope
    ? scheduledState.messages
    : [];

  return { scheduledMessages, schedule, cancel, refresh };
}
