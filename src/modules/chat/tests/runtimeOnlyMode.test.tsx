import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import React, { createRef } from 'react';
import { beforeEach, test, vi } from 'vitest';

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    comicRuntimeOnly: true,
  };
});

vi.mock('@/modules/chat/composer/ComposerModelMenu', () => ({
  default: () => 'MODEL_MENU_SENTINEL',
}));

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({
  useVoiceAvailable: () => false,
}));

vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => undefined, stop: () => undefined }),
}));

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import '@/modules/i18n';
import { readSelectedProvider } from '@/shared/selectedProvider';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

const noop = () => undefined;

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

test('runtime selector offers only Codex and Claude Code without model names or a model library', () => {
  const setProvider = vi.fn();

  render(
    <ProviderSelectionEmptyState
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={setProvider}
      textareaRef={createRef<HTMLTextAreaElement>()}
      providerModels={{
        claude: 'HIDDEN_CLAUDE_MODEL',
        codex: 'HIDDEN_CODEX_MODEL',
        cursor: 'HIDDEN_CURSOR_MODEL',
        opencode: 'HIDDEN_OPENCODE_MODEL',
      }}
      setProviderModel={vi.fn()}
      providerModelCatalog={{
        claude: {
          DEFAULT: 'HIDDEN_CLAUDE_MODEL',
          OPTIONS: [{ value: 'HIDDEN_CLAUDE_MODEL', label: 'Hidden Claude model' }],
        },
      }}
      providerModelActions={{ create: vi.fn(), update: vi.fn(), remove: vi.fn() }}
      canSendMessages={true}
      providerModelsLoading={false}
      tasksEnabled={false}
      isTaskMasterInstalled={false}
      setInput={vi.fn()}
    />,
  );

  assert.equal(screen.queryByText('Hidden Claude model'), null);
  assert.equal(screen.queryByText('HIDDEN_CLAUDE_MODEL'), null);
  assert.ok(screen.getByText('Claude Code'));

  fireEvent.click(screen.getByRole('button'));
  const dialog = screen.getByRole('dialog');

  assert.ok(within(dialog).getByText('Codex'));
  assert.ok(within(dialog).getByText('Claude Code'));
  assert.equal(within(dialog).queryByText('Cursor'), null);
  assert.equal(within(dialog).queryByText('OpenCode'), null);
  assert.equal(within(dialog).queryByText('Hidden Claude model'), null);
  assert.equal(within(dialog).queryByText('Manage models'), null);
});

test('runtime-only builds ignore a persisted provider outside the runtime allowlist', () => {
  writeUserPreference('selectedProvider', 'cursor');
  assert.equal(readSelectedProvider(), 'claude');

  writeUserPreference('selectedProvider', 'codex');
  assert.equal(readSelectedProvider(), 'codex');
});

test('empty-state chat capability defaults to denied for a direct mount', () => {
  render(
    <ProviderSelectionEmptyState
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={vi.fn()}
      textareaRef={createRef<HTMLTextAreaElement>()}
      providerModels={{
        claude: 'claude-model',
        codex: 'codex-model',
        cursor: 'cursor-model',
        opencode: 'opencode-model',
      }}
      setProviderModel={vi.fn()}
      providerModelCatalog={{}}
      providerModelActions={{ create: vi.fn(), update: vi.fn(), remove: vi.fn() }}
      providerModelsLoading={false}
      tasksEnabled={false}
      isTaskMasterInstalled={false}
      setInput={vi.fn()}
    />,
  );

  assert.ok(screen.getByRole('status'));
  assert.equal(screen.queryByRole('button'), null);
});

test('read-only historical Cursor sessions do not show a task shortcut that would imply sending is available', () => {
  render(
    <ProviderSelectionEmptyState
      selectedSession={{ id: 'legacy-cursor', provider: 'cursor' }}
      currentSessionId="legacy-cursor"
      provider="codex"
      setProvider={vi.fn()}
      textareaRef={createRef<HTMLTextAreaElement>()}
      providerModels={{
        claude: 'claude-model',
        codex: 'codex-model',
        cursor: 'cursor-model',
        opencode: 'opencode-model',
      }}
      setProviderModel={vi.fn()}
      providerModelCatalog={{}}
      providerModelActions={{ create: vi.fn(), update: vi.fn(), remove: vi.fn() }}
      canManageProviderModels={false}
      readOnly
      providerModelsLoading={false}
      tasksEnabled
      isTaskMasterInstalled
      onShowAllTasks={vi.fn()}
      setInput={vi.fn()}
    />,
  );

  assert.equal(screen.queryByText('Start Task'), null);
});

test('managed identities that cannot send do not get an interactive runtime selector', () => {
  render(
    <ProviderSelectionEmptyState
      selectedSession={null}
      currentSessionId={null}
      provider="claude"
      setProvider={vi.fn()}
      textareaRef={createRef<HTMLTextAreaElement>()}
      providerModels={{
        claude: 'claude-model',
        codex: 'codex-model',
        cursor: 'cursor-model',
        opencode: 'opencode-model',
      }}
      setProviderModel={vi.fn()}
      providerModelCatalog={{}}
      providerModelActions={{ create: vi.fn(), update: vi.fn(), remove: vi.fn() }}
      canManageProviderModels={false}
      canSendMessages={false}
      sendDisabledReason="Chat is read-only until your DingTalk identity is verified."
      readOnly
      providerModelsLoading={false}
      tasksEnabled
      isTaskMasterInstalled
      onShowAllTasks={vi.fn()}
      setInput={vi.fn()}
    />,
  );

  assert.ok(screen.getByRole('status'));
  assert.ok(screen.getByText('Chat is read-only until your DingTalk identity is verified.'));
  assert.equal(screen.queryByRole('button'), null);
  assert.equal(screen.queryByText('Claude Code'), null);
});

test('runtime-only composer hides the combined model and effort menu', () => {
  render(
    <ChatComposer
      pendingPermissionRequests={[]}
      handlePermissionDecision={noop}
      handleGrantToolPermission={() => ({ success: true })}
      activity={null}
      isLoading={false}
      onAbortSession={noop}
      permissionMode="default"
      availablePermissionModes={['default']}
      onSelectPermissionMode={noop}
      providerLabel="Codex"
      effort="high"
      availableEffortOptions={[{ value: 'high' }]}
      onSelectEffort={noop}
      model="HIDDEN_MODEL"
      availableModelOptions={[{ value: 'HIDDEN_MODEL', label: 'Hidden model' }]}
      onSelectModel={noop}
      modelsLoading={false}
      tokenBudget={null}
      onShowTokenUsage={noop}
      slashCommandsCount={0}
      onToggleCommandMenu={noop}
      hasInput={false}
      onClearInput={noop}
      onSubmit={noop}
      isDragActive={false}
      queuedDraft={null}
      isEditingSentMessage={false}
      onCancelEditMessage={noop}
      scheduledMessages={[]}
      onScheduleMessage={noop}
      onCancelScheduledMessage={noop}
      onEditQueuedDraft={noop}
      onDeleteQueuedDraft={noop}
      attachedFiles={[]}
      onRemoveAttachment={noop}
      fileErrors={new Map()}
      showFileDropdown={false}
      filteredFiles={[]}
      selectedFileIndex={-1}
      onSelectFile={noop}
      filteredCommands={[]}
      selectedCommandIndex={-1}
      onCommandSelect={noop}
      onCloseCommandMenu={noop}
      isCommandMenuOpen={false}
      frequentCommands={[]}
      getRootProps={() => ({})}
      getInputProps={() => ({})}
      openAttachmentPicker={noop}
      inputHighlightRef={createRef<HTMLDivElement>()}
      renderInputWithMentions={(text) => text}
      textareaRef={createRef<HTMLTextAreaElement>()}
      input=""
      onInputChange={noop}
      onTextareaClick={noop}
      onTextareaKeyDown={noop}
      onTextareaPaste={noop}
      onTextareaScrollSync={noop}
      onTextareaInput={noop}
      placeholder="Ask Codex"
      isTextareaExpanded={false}
    />,
  );

  assert.equal(screen.queryByText('MODEL_MENU_SENTINEL'), null);
  assert.equal(screen.queryByText('HIDDEN_MODEL'), null);
  assert.equal(screen.queryByText('Hidden model'), null);
});
