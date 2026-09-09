import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Braces, Check, Download, FileCode2, FileText, Link2, Loader2, Trash2, TriangleAlert } from 'lucide-react';

import { ActionMenu } from '@/shared/ui';
import { api } from '@/shared/api';
import type { ChatMessage, DiffLine, LLMProvider, Project } from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';
import {
  downloadTranscriptExport,
  type TranscriptExportFormat,
} from '@/modules/chat/utils/chatExport';

type ChatExportMenuProps = {
  messages: ChatMessage[];
  sessionTitle?: string;
  provider: LLMProvider | string;
  selectedProject?: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  sessionId?: string | null;
  /** Session-share metadata is a server-authorized write; exports remain available when false. */
  canManageShare?: boolean;
  /**
   * Loads the rest of the conversation before exporting.
   *
   * The transcript is paged, so `messages` is usually the tail of it. Without
   * this, exporting a long session silently produced a file containing the
   * last twenty messages.
   */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

const FORMATS: Array<{ id: TranscriptExportFormat; icon: typeof FileText; labelKey: string; descriptionKey: string }> = [
  { id: 'html', icon: FileCode2, labelKey: 'export.html.label', descriptionKey: 'export.html.description' },
  { id: 'markdown', icon: FileText, labelKey: 'export.markdown.label', descriptionKey: 'export.markdown.description' },
  { id: 'json', icon: Braces, labelKey: 'export.json.label', descriptionKey: 'export.json.description' },
];

type ActiveSessionShare = {
  shareId: string;
  expiresAt: string;
};

type ShareState = {
  sessionId: string;
  status: 'loading' | 'none' | 'creating' | 'active' | 'copied' | 'copy_failed' | 'revoking' | 'revoked' | 'error';
  operation?: 'load' | 'create' | 'revoke';
  share?: ActiveSessionShare;
  url?: string;
};

function responseError(payload: { error?: string | { message?: string } }, fallback: string): Error {
  return new Error(
    typeof payload.error === 'string'
      ? payload.error
      : payload.error?.message || fallback,
  );
}

/**
 * Rendered by chat's ChatMessagesPane header so the open conversation can be
 * downloaded as a self-contained web page, as Markdown, or as JSON.
 */
export default function ChatExportMenu({
  messages,
  sessionTitle,
  provider,
  selectedProject,
  createDiff,
  sessionId,
  // Sharing creates/revokes server-side metadata; an omitted capability must
  // therefore be treated as denied for direct mounts and stale callers.
  canManageShare = false,
  onLoadFullTranscript,
}: ChatExportMenuProps) {
  const { t } = useTranslation('chat');
  // Building a large transcript takes long enough to notice, and the download
  // only appears at the end — without this the button looks unresponsive.
  const [busyFormat, setBusyFormat] = useState<TranscriptExportFormat | null>(null);
  // The active share is hydrated from the server so it remains manageable
  // after a page refresh; a raw public token is retained only for this tab.
  const [shareState, setShareState] = useState<ShareState | null>(null);
  // A failed status lookup is retried explicitly without coupling that retry
  // to unrelated menu renders.
  const [shareLoadAttempt, setShareLoadAttempt] = useState(0);

  const currentShareState: ShareState | null = !canManageShare
    ? null
    : shareState?.sessionId === sessionId
      ? shareState
      : sessionId
        ? { sessionId, status: 'loading' }
        : null;
  const currentShareStatus = currentShareState?.status ?? null;
  const activeShare = currentShareState?.share;
  const hasMessages = messages.length > 0;

  useEffect(() => {
    if (!canManageShare || !sessionId || !hasMessages) return;

    let cancelled = false;
    void (async () => {
      try {
        const response = await api.listSessionShares(sessionId);
        const payload = await response.json() as {
          data?: { shares?: ActiveSessionShare[] };
          error?: string | { message?: string };
        };
        if (!response.ok || !Array.isArray(payload.data?.shares)) {
          throw responseError(payload, 'Unable to load share status');
        }

        const candidate = payload.data.shares[0];
        const share = candidate
          && typeof candidate.shareId === 'string'
          && typeof candidate.expiresAt === 'string'
          ? candidate
          : null;
        if (!cancelled) {
          setShareState({
            sessionId,
            status: share ? 'active' : 'none',
            ...(share ? { share } : {}),
          });
        }
      } catch (error) {
        console.error('Failed to load read-only share status:', error);
        if (!cancelled) {
          setShareState({ sessionId, status: 'error', operation: 'load' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canManageShare, hasMessages, sessionId, shareLoadAttempt]);

  if (messages.length === 0) {
    return null;
  }

  const runExport = async (format: TranscriptExportFormat) => {
    setBusyFormat(format);
    try {
      const fullMessages = (await onLoadFullTranscript?.()) ?? messages;
      await downloadTranscriptExport(format, {
        messages: fullMessages.length > 0 ? fullMessages : messages,
        sessionTitle: sessionTitle?.trim() || t('export.untitled'),
        provider,
        selectedProject,
        createDiff,
      });
    } catch (error) {
      console.error('Failed to export conversation:', error);
    } finally {
      setBusyFormat(null);
    }
  };

  const createReadOnlyShare = async () => {
    if (!canManageShare || !sessionId || currentShareStatus === 'creating') return;

    if (
      shareState?.sessionId === sessionId
      && shareState.url
      && (shareState.status === 'copied' || shareState.status === 'copy_failed')
    ) {
      const copied = await copyTextToClipboard(shareState.url);
      setShareState({ ...shareState, status: copied ? 'copied' : 'copy_failed' });
      return;
    }

    if (!window.confirm(t('export.share.confirm'))) {
      return;
    }

    setShareState({ sessionId, status: 'creating' });
    try {
      const response = await api.createSessionShare(sessionId);
      const payload = await response.json() as {
        data?: { shareId?: string; path?: string; expiresAt?: string };
        error?: string | { message?: string };
      };
      const sharePath = payload.data?.path;
      const shareId = payload.data?.shareId;
      const expiresAt = payload.data?.expiresAt;
      if (!response.ok || !sharePath || !shareId || !expiresAt) {
        throw responseError(payload, 'Unable to create share link');
      }

      const shareUrl = new URL(sharePath, window.location.origin).toString();
      const copied = await copyTextToClipboard(shareUrl);
      setShareState({
        sessionId,
        status: copied ? 'copied' : 'copy_failed',
        share: { shareId, expiresAt },
        url: shareUrl,
      });
    } catch (error) {
      console.error('Failed to create read-only share:', error);
      setShareState({ sessionId, status: 'error', operation: 'create' });
    }
  };

  const revokeReadOnlyShare = async () => {
    if (!canManageShare || !sessionId || !activeShare || currentShareStatus === 'revoking') return;

    setShareState({
      sessionId,
      status: 'revoking',
      share: activeShare,
      ...(currentShareState?.url ? { url: currentShareState.url } : {}),
    });
    try {
      const response = await api.revokeSessionShare(activeShare.shareId);
      const payload = await response.json() as {
        data?: { revoked?: boolean };
        error?: string | { message?: string };
      };
      if (!response.ok || payload.data?.revoked !== true) {
        throw responseError(payload, 'Unable to revoke share link');
      }
      setShareState({ sessionId, status: 'revoked' });
    } catch (error) {
      console.error('Failed to revoke read-only share:', error);
      setShareState({
        sessionId,
        status: 'error',
        operation: 'revoke',
        share: activeShare,
        ...(currentShareState?.url ? { url: currentShareState.url } : {}),
      });
    }
  };

  const retryShareStatus = () => {
    if (!sessionId) return;
    setShareState({ sessionId, status: 'loading' });
    setShareLoadAttempt((attempt) => attempt + 1);
  };

  const canCopyCreatedShare = Boolean(
    currentShareState?.url
    && (currentShareStatus === 'copied' || currentShareStatus === 'copy_failed'),
  );
  const canCreateShare = currentShareStatus === 'none'
    || currentShareStatus === 'revoked'
    || (currentShareStatus === 'error' && currentShareState?.operation === 'create');
  const shareItem = canManageShare && sessionId && (canCopyCreatedShare || canCreateShare) ? {
    key: 'read-only-share',
    label: currentShareStatus === 'copied'
      ? t('export.share.copied')
      : currentShareStatus === 'copy_failed'
        ? t('export.share.copyFailed')
        : currentShareStatus === 'revoked'
          ? t('export.share.revoked')
          : currentShareStatus === 'error'
            ? t('export.share.failed')
            : t('export.share.label'),
    description: currentShareStatus === 'copied'
      ? t('export.share.copiedDescription')
      : currentShareStatus === 'copy_failed'
        ? t('export.share.copyFailedDescription')
        : currentShareStatus === 'revoked'
          ? t('export.share.revokedDescription')
          : currentShareStatus === 'error'
            ? t('export.share.failedDescription')
            : t('export.share.description'),
    icon: currentShareStatus === 'copied'
      ? Check
      : currentShareStatus === 'copy_failed' || currentShareStatus === 'error'
        ? TriangleAlert
        : Link2,
    loading: currentShareStatus === 'creating',
    showDividerBefore: true,
    closeOnSelect: false,
    onSelect: () => { void createReadOnlyShare(); },
  } : null;

  const statusItem = canManageShare && sessionId && currentShareStatus === 'loading' ? {
    key: 'read-only-share-status',
    label: t('export.share.checking'),
    description: t('export.share.checkingDescription'),
    icon: Link2,
    loading: true,
    showDividerBefore: true,
    closeOnSelect: false,
    onSelect: () => undefined,
    } : canManageShare && sessionId && currentShareStatus === 'error' && currentShareState?.operation === 'load' ? {
    key: 'read-only-share-status',
    label: t('export.share.statusFailed'),
    description: t('export.share.statusFailedDescription'),
    icon: TriangleAlert,
    showDividerBefore: true,
    closeOnSelect: false,
    onSelect: retryShareStatus,
  } : null;

  const revokeItem = canManageShare && sessionId && activeShare ? {
    key: 'revoke-read-only-share',
    label: currentShareStatus === 'error' && currentShareState?.operation === 'revoke'
      ? t('export.share.revokeFailed')
      : t('export.share.revoke'),
    description: currentShareStatus === 'error' && currentShareState?.operation === 'revoke'
      ? t('export.share.revokeFailedDescription')
      : t('export.share.revokeDescription'),
    icon: currentShareStatus === 'error' && currentShareState?.operation === 'revoke'
      ? TriangleAlert
      : Trash2,
    isDanger: true,
    loading: currentShareStatus === 'revoking',
    showDividerBefore: !shareItem,
    closeOnSelect: false,
    onSelect: () => { void revokeReadOnlyShare(); },
  } : null;

  return (
    <ActionMenu
      icon={busyFormat || currentShareStatus === 'loading' || currentShareStatus === 'creating' || currentShareStatus === 'revoking' ? Loader2 : Download}
      iconOnly
      label={t('export.trigger')}
      ariaLabel={t('export.trigger')}
      triggerClassName="h-8 w-8 rounded-lg border border-border/50 text-muted-foreground hover:bg-accent hover:text-foreground"
      menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
      header={(
        <div className="mb-1 border-b border-border px-3 py-2">
          <p className="text-xs font-medium text-foreground">{t('export.heading')}</p>
        </div>
      )}
      items={[
        ...FORMATS.map((format) => ({
          key: format.id,
          label: t(format.labelKey),
          description: t(format.descriptionKey),
          icon: format.icon,
          loading: busyFormat === format.id,
          onSelect: () => { void runExport(format.id); },
        })),
        ...(statusItem ? [statusItem] : []),
        ...(shareItem ? [shareItem] : []),
        ...(revokeItem ? [revokeItem] : []),
      ]}
    />
  );
}
