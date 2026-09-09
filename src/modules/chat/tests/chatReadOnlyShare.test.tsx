import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { ChatMessage } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  createSessionShare: vi.fn(),
  listSessionShares: vi.fn(),
  revokeSessionShare: vi.fn(),
  copyTextToClipboard: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    createSessionShare: mocks.createSessionShare,
    listSessionShares: mocks.listSessionShares,
    revokeSessionShare: mocks.revokeSessionShare,
  },
}));

vi.mock('@/shared/utils', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));

vi.mock('@/modules/chat/utils/chatExport', () => ({
  downloadTranscriptExport: vi.fn(),
}));

vi.mock('@/shared/ui', () => ({
  ActionMenu: ({ items }: { items: Array<{ key: string; label: string; onSelect: () => void }> }) => (
    <div>
      {items.map((item) => (
        <button key={item.key} type="button" onClick={item.onSelect}>{item.label}</button>
      ))}
    </div>
  ),
}));

const { default: ChatExportMenu } = await import('@/modules/chat/transcript/ChatExportMenu');

const MESSAGES: ChatMessage[] = [{
  type: 'assistant',
  content: 'Done',
  timestamp: '2026-09-01T00:00:00.000Z',
}];

function renderMenu(
  sessionId: string | null = 'session-1',
  options: { canManageShare?: boolean } = { canManageShare: true },
) {
  return render(
    <ChatExportMenu
      messages={MESSAGES}
      sessionTitle="Test session"
      provider="codex"
      createDiff={() => []}
      sessionId={sessionId}
      canManageShare={options.canManageShare}
    />,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mocks.createSessionShare.mockReset();
  mocks.listSessionShares.mockReset();
  mocks.revokeSessionShare.mockReset();
  mocks.copyTextToClipboard.mockReset();
  mocks.listSessionShares.mockImplementation(() => Promise.resolve(jsonResponse({
    data: { shares: [] },
  })));
  mocks.revokeSessionShare.mockImplementation(() => Promise.resolve(jsonResponse({
    data: { revoked: true },
  })));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

test('creates a read-only snapshot, copies its public URL and shows success', async () => {
  mocks.createSessionShare.mockResolvedValue(jsonResponse({
    data: {
      shareId: 'share-1',
      path: '/share/public-token',
      expiresAt: '2026-09-08T00:00:00.000Z',
    },
  }, 201));
  mocks.copyTextToClipboard.mockResolvedValue(true);

  renderMenu();
  fireEvent.click(await screen.findByText('export.share.label'));

  await waitFor(() => assert.equal(mocks.createSessionShare.mock.calls.length, 1));
  assert.deepEqual(mocks.createSessionShare.mock.calls[0], ['session-1']);
  await waitFor(() => assert.equal(mocks.copyTextToClipboard.mock.calls.length, 1));
  assert.equal(mocks.copyTextToClipboard.mock.calls[0][0], `${window.location.origin}/share/public-token`);
  assert.ok(screen.getByText('export.share.copied'));
  assert.ok(screen.getByText('export.share.revoke'));
});

test('shows copy and server failures without hiding the normal export actions', async () => {
  mocks.createSessionShare.mockResolvedValueOnce(jsonResponse({
    data: {
      shareId: 'share-1',
      path: '/share/public-token',
      expiresAt: '2026-09-08T00:00:00.000Z',
    },
  }, 201));
  mocks.copyTextToClipboard.mockResolvedValue(false);

  const { rerender } = renderMenu();
  fireEvent.click(await screen.findByText('export.share.label'));
  await waitFor(() => assert.ok(screen.getByText('export.share.copyFailed')));
  assert.ok(screen.getByText('export.markdown.label'));

  mocks.createSessionShare.mockResolvedValueOnce(jsonResponse({
    error: { message: 'failed' },
  }, 500));
  rerender(
    <ChatExportMenu
      messages={MESSAGES}
      sessionTitle="Another session"
      provider="codex"
      createDiff={() => []}
      sessionId="session-2"
      canManageShare
    />,
  );
  fireEvent.click(await screen.findByText('export.share.label'));
  await waitFor(() => assert.ok(screen.getByText('export.share.failed')));
});

test('does not show share creation when there is no persisted session', () => {
  renderMenu(null);
  assert.equal(screen.queryByText('export.share.label'), null);
  assert.equal(mocks.listSessionShares.mock.calls.length, 0);
});

test('keeps transcript downloads but hides share mutations when the actor is restricted', async () => {
  renderMenu('session-1', { canManageShare: false });

  assert.ok(await screen.findByText('export.markdown.label'));
  assert.equal(screen.queryByText('export.share.label'), null);
  assert.equal(screen.queryByText('export.share.revoke'), null);
  assert.equal(mocks.listSessionShares.mock.calls.length, 0);
  assert.equal(mocks.createSessionShare.mock.calls.length, 0);
  assert.equal(mocks.revokeSessionShare.mock.calls.length, 0);
});

test('omitting the share capability fails closed for a direct mount', async () => {
  render(
    <ChatExportMenu
      messages={MESSAGES}
      sessionTitle="Unprivileged session"
      provider="codex"
      createDiff={() => []}
      sessionId="session-1"
    />,
  );

  assert.ok(await screen.findByText('export.markdown.label'));
  assert.equal(screen.queryByText('export.share.label'), null);
  assert.equal(mocks.listSessionShares.mock.calls.length, 0);
});

test('does not create a public snapshot when the warning is declined', async () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  renderMenu();

  fireEvent.click(await screen.findByText('export.share.label'));

  await Promise.resolve();
  assert.equal(mocks.createSessionShare.mock.calls.length, 0);
});

test('loads the current user share after refresh and can revoke it', async () => {
  mocks.listSessionShares.mockImplementationOnce(() => Promise.resolve(jsonResponse({
    data: {
      shares: [{
        shareId: 'share-existing',
        expiresAt: '2026-09-08T00:00:00.000Z',
      }],
    },
  })));

  renderMenu();
  fireEvent.click(await screen.findByText('export.share.revoke'));

  await waitFor(() => assert.deepEqual(
    mocks.revokeSessionShare.mock.calls,
    [['share-existing']],
  ));
  await waitFor(() => assert.ok(screen.getByText('export.share.revoked')));
  assert.equal(mocks.createSessionShare.mock.calls.length, 0);
});

test('keeps the active share available when revoke fails so the user can retry', async () => {
  mocks.listSessionShares.mockImplementationOnce(() => Promise.resolve(jsonResponse({
    data: {
      shares: [{
        shareId: 'share-existing',
        expiresAt: '2026-09-08T00:00:00.000Z',
      }],
    },
  })));
  mocks.revokeSessionShare.mockImplementationOnce(() => Promise.resolve(jsonResponse({
    error: { message: 'failed' },
  }, 500)));

  renderMenu();
  fireEvent.click(await screen.findByText('export.share.revoke'));
  await waitFor(() => assert.ok(screen.getByText('export.share.revokeFailed')));

  fireEvent.click(screen.getByText('export.share.revokeFailed'));
  await waitFor(() => assert.deepEqual(
    mocks.revokeSessionShare.mock.calls,
    [['share-existing'], ['share-existing']],
  ));
  await waitFor(() => assert.ok(screen.getByText('export.share.revoked')));
  assert.equal(vi.mocked(window.confirm).mock.calls.length, 0);
});

test('ignores a stale share lookup after switching sessions', async () => {
  let resolveFirstLookup: ((response: Response) => void) | undefined;
  const firstLookup = new Promise<Response>((resolve) => {
    resolveFirstLookup = resolve;
  });
  mocks.listSessionShares.mockImplementation((sessionId: string) => sessionId === 'session-1'
    ? firstLookup
    : Promise.resolve(jsonResponse({
      data: {
        shares: [{
          shareId: 'share-session-2',
          expiresAt: '2026-09-08T00:00:00.000Z',
        }],
      },
    })));

  const { rerender } = renderMenu('session-1');
  await waitFor(() => assert.deepEqual(mocks.listSessionShares.mock.calls, [['session-1']]));
  rerender(
    <ChatExportMenu
      messages={MESSAGES}
      sessionTitle="Second session"
      provider="codex"
      createDiff={() => []}
      sessionId="session-2"
      canManageShare
    />,
  );
  await screen.findByText('export.share.revoke');

  resolveFirstLookup?.(jsonResponse({
    data: {
      shares: [{
        shareId: 'stale-session-1-share',
        expiresAt: '2026-09-08T00:00:00.000Z',
      }],
    },
  }));
  await Promise.resolve();
  fireEvent.click(screen.getByText('export.share.revoke'));

  await waitFor(() => assert.deepEqual(
    mocks.revokeSessionShare.mock.calls,
    [['share-session-2']],
  ));
});
