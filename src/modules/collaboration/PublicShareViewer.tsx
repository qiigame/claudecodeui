import { AlertCircle, Clock3, Loader2, MessageSquareText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import SafeMarkdown from '@/modules/collaboration/SafeMarkdown';
import { api } from '@/shared/api';
import type { PublicSessionSharePayload } from '@/shared/types';

type ShareLoadState =
  | { status: 'loading'; token: string }
  | { status: 'ready'; token: string; share: PublicSessionSharePayload }
  | { status: 'error'; token: string };

type ShareApiEnvelope = {
  data?: PublicSessionSharePayload;
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Rendered directly by App for unauthenticated, read-only /share/:token links. */
export default function PublicShareViewer() {
  const { token = '' } = useParams<{ token: string }>();
  // This discriminated state is the complete public request lifecycle; it
  // deliberately carries no authenticated application or runtime state.
  const [loadState, setLoadState] = useState<ShareLoadState>({ status: 'loading', token });
  const currentLoadState: ShareLoadState = loadState.token === token
    ? loadState
    : { status: 'loading', token };

  useEffect(() => {
    const previousTitle = document.title;
    const existingRobotsMeta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const robotsMeta = existingRobotsMeta ?? document.createElement('meta');
    if (!existingRobotsMeta) {
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.content = 'noindex, nofollow, noarchive';
    document.title = 'Shared conversation · CloudCLI';

    return () => {
      document.title = previousTitle;
      if (!existingRobotsMeta) robotsMeta.remove();
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    void api.publicSessionShare(token)
      .then(async (response) => {
        const payload = await response.json() as ShareApiEnvelope;
        if (!response.ok || !payload.data) throw new Error('Share unavailable');
        if (!abortController.signal.aborted) setLoadState({ status: 'ready', token, share: payload.data });
      })
      .catch(() => {
        if (!abortController.signal.aborted) setLoadState({ status: 'error', token });
      });

    return () => abortController.abort();
  }, [token]);

  if (currentLoadState.status === 'loading') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading shared conversation…
      </div>
    );
  }

  if (currentLoadState.status === 'error') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h1 className="text-lg font-semibold text-foreground">This share link is unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            It may be invalid, expired, or revoked by its creator.
          </p>
        </div>
      </div>
    );
  }

  const { snapshot, expiresAt } = currentLoadState.share;
  return (
    <div className="fixed inset-0 overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 border-b border-border/70 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-4xl px-5 py-4 sm:px-8">
          <div className="flex items-start gap-3">
            <MessageSquareText className="mt-1 h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-foreground">{snapshot.title}</h1>
              <p className="text-sm text-muted-foreground">{snapshot.projectName} · {snapshot.provider}</p>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" /> Expires {formatTimestamp(expiresAt)}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-5 py-8 sm:px-8">
        {snapshot.isTruncated && (
          <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
            This snapshot was shortened for safe public sharing.
          </div>
        )}

        {snapshot.messages.map((message, index) => (
          <article
            key={`${message.timestamp}-${index}`}
            className={message.role === 'user'
              ? 'ml-auto max-w-[92%] rounded-2xl bg-muted px-4 py-3 sm:max-w-[85%]'
              : 'max-w-full border-b border-border/50 pb-5'}
          >
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {message.role === 'user' ? 'User' : 'Assistant'} · {formatTimestamp(message.timestamp)}
            </div>
            <div className="prose prose-slate max-w-none text-foreground dark:prose-invert">
              <SafeMarkdown content={message.content} />
            </div>
          </article>
        ))}

        {snapshot.messages.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">This snapshot contains no public messages.</p>
        )}
      </main>
    </div>
  );
}
