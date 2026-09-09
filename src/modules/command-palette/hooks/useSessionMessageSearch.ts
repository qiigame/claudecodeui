import { useEffect, useRef, useState } from 'react';

import { api, consumeSseResponse } from '@/shared/api';
import type { LLMProvider } from '@/shared/types';

export type SessionMessageMatch = {
  sessionId: string;
  label: string;
  snippet: string;
  provider: LLMProvider;
};

type ProjectResult = {
  projectId: string | null;
  projectName: string;
  sessions: Array<{
    sessionId: string;
    provider: LLMProvider;
    sessionSummary: string;
    matches: Array<{ snippet: string }>;
  }>;
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export function useSessionMessageSearch(
  projectId: string | undefined,
  query: string,
  enabled: boolean,
) {
  const [items, setItems] = useState<SessionMessageMatch[]>([]);
  const seqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    seqRef.current++;

    if (!enabled || !projectId || trimmed.length < MIN_QUERY) {
      setItems([]);
      return;
    }

    let activeController: AbortController | null = null;

    const handle = setTimeout(() => {
      const seq = ++seqRef.current;
      const controller = new AbortController();
      activeController = controller;
      searchAbortRef.current = controller;
      const accumulated: SessionMessageMatch[] = [];

      const runSearch = async () => {
        try {
          const response = await api.searchConversations(trimmed, 50, {
            signal: controller.signal,
          });
          await consumeSseResponse(response, ({ event, data }) => {
            if (event !== 'result' || seq !== seqRef.current || controller.signal.aborted) {
              return;
            }

            try {
              const payload = JSON.parse(data) as { projectResult: ProjectResult };
              const projectResult = payload.projectResult;
              if (projectResult.projectId !== projectId) return;
              for (const session of projectResult.sessions) {
                accumulated.push({
                  sessionId: session.sessionId,
                  label: session.sessionSummary || session.sessionId,
                  snippet: session.matches[0]?.snippet ?? '',
                  provider: session.provider,
                });
              }
              setItems([...accumulated]);
            } catch {
              // Ignore malformed
            }
          });
        } catch (error) {
          if (!controller.signal.aborted && seq === seqRef.current) {
            // A failed search should leave any partial matches visible, just
            // as the old EventSource error handler did.
            console.error('[CommandPalette] Session message search failed:', error);
          }
        } finally {
          if (searchAbortRef.current === controller) {
            searchAbortRef.current = null;
          }
          if (activeController === controller) {
            activeController = null;
          }
        }
      };

      void runSearch();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
      activeController?.abort();
      if (searchAbortRef.current === activeController) {
        searchAbortRef.current = null;
      }
    };
  }, [projectId, query, enabled]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
    };
  }, []);

  return items;
}
