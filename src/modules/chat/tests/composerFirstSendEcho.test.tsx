import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project } from '@/shared/types';

/**
 * Creating a brand-new session can take seconds on a deployment that fetches
 * the remote and provisions a worktree first. The composer must echo the
 * message and clear itself before that allocation finishes, and hand the text
 * back if the allocation fails.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const createSession = vi.fn();

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      providers: { createSession: (...args: unknown[]) => createSession(...args) },
    },
  };
});

const renderNewChatComposer = () => {
  const addMessage = vi.fn<(message: ChatMessage) => void>();
  const sendMessage = vi.fn();
  const onSessionEstablished = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: null,
    currentSessionId: null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    canExecuteCommands: true,
    // Skip worktree planning; allocation latency is simulated by createSession.
    canProvisionWorkspace: false,
    canUploadAttachments: true,
    canSendMessages: true,
    canApproveTools: true,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: () => undefined,
    addMessage,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
    onSessionEstablished,
  }));
  return { view, addMessage, sendMessage, onSessionEstablished };
};

const submitEvent = () => ({ preventDefault: () => undefined }) as unknown as Parameters<
  ReturnType<typeof useChatComposerState>['handleSubmit']
>[0];

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  createSession.mockReset();
});

test('a first message is echoed and the composer cleared before the session exists', async () => {
  let resolveCreation: (value: unknown) => void = () => undefined;
  createSession.mockReturnValue(new Promise((resolve) => {
    resolveCreation = resolve;
  }));
  const { view, addMessage, sendMessage, onSessionEstablished } = renderNewChatComposer();

  await act(async () => {
    view.result.current.setInput('hello there');
  });

  let submission: Promise<void> = Promise.resolve();
  await act(async () => {
    submission = view.result.current.handleSubmit(submitEvent());
  });

  // Allocation is still pending: the echo is visible and the input is empty,
  // but nothing has been sent over the websocket yet.
  assert.equal(addMessage.mock.calls.length, 1);
  assert.equal(addMessage.mock.calls[0][0].type, 'user');
  assert.equal(addMessage.mock.calls[0][0].content, 'hello there');
  assert.equal(view.result.current.input, '');
  assert.equal(sendMessage.mock.calls.length, 0);

  await act(async () => {
    resolveCreation({ ok: true, json: async () => ({ data: { sessionId: 'session-new' } }) });
    await submission;
  });

  assert.equal(onSessionEstablished.mock.calls[0][0], 'session-new');
  assert.equal(sendMessage.mock.calls.length, 1);
  assert.equal(sendMessage.mock.calls[0][0].sessionId, 'session-new');
  assert.equal(sendMessage.mock.calls[0][0].content, 'hello there');
  assert.equal(addMessage.mock.calls.length, 1, 'the message must not be echoed twice');
});

test('a failed session allocation shows the error and returns the text to the composer', async () => {
  createSession.mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: 'fetch failed' } }),
  });
  const { view, addMessage, sendMessage } = renderNewChatComposer();

  await act(async () => {
    view.result.current.setInput('keep me');
  });
  await act(async () => {
    await view.result.current.handleSubmit(submitEvent());
  });

  assert.deepEqual(addMessage.mock.calls.map(([message]) => message.type), ['user', 'error']);
  assert.match(String(addMessage.mock.calls[1][0].content), /fetch failed/);
  assert.equal(view.result.current.input, 'keep me');
  assert.equal(sendMessage.mock.calls.length, 0);
});
