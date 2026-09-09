import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import type { LLMProvider, Project, SlashCommand } from '@/shared/types';

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  skills: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    commands: { list: apiMocks.list },
    providers: { skills: apiMocks.skills },
  },
}));

const project = {
  projectId: 'project-1',
  path: '/workspace/project-1',
  fullPath: '/workspace/project-1',
  displayName: 'Project',
  isStarred: false,
  sessions: [],
} as Project;

const renderCommands = (canManageSettings: boolean, canExecuteCommands = true) => renderHook(() => useSlashCommands({
  selectedProject: project,
  provider: 'claude' as LLMProvider,
  canManageSettings,
  canExecuteCommands,
  input: '',
  setInput: vi.fn(),
  textareaRef: { current: null },
  onExecuteCommand: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  apiMocks.list.mockReset().mockResolvedValue(new Response(JSON.stringify({
    builtIn: [
      { name: '/config', description: 'Open settings' },
      { name: '/help', description: 'Show help' },
    ] satisfies SlashCommand[],
    custom: [],
  }), { status: 200 }));
  apiMocks.skills.mockReset().mockResolvedValue(new Response(JSON.stringify({
    success: true,
    data: { skills: [] },
  }), { status: 200 }));
});

test('non-admin command discovery hides /config', async () => {
  const { result } = renderCommands(false);

  await waitFor(() => assert.equal(result.current.slashCommandsCount, 1));
  assert.deepEqual(result.current.slashCommands.map((command) => command.name), ['/help']);
  assert.deepEqual(apiMocks.list.mock.calls[0]?.[0], {
    projectId: project.projectId,
    projectPath: project.fullPath,
  });
});

test('the settings administrator retains /config', async () => {
  const { result } = renderCommands(true);

  await waitFor(() => assert.equal(result.current.slashCommandsCount, 2));
  assert.deepEqual(
    result.current.slashCommands.map((command) => command.name),
    ['/config', '/help'],
  );
});

test('a deployment without command execution does not discover or expose slash commands', async () => {
  const { result } = renderCommands(true, false);

  await waitFor(() => assert.equal(result.current.slashCommandsCount, 0));
  assert.deepEqual(result.current.filteredCommands, []);
  assert.equal(apiMocks.list.mock.calls.length, 0);
});

test('omitting command execution capability fails closed', async () => {
  const { result } = renderHook(() => useSlashCommands({
    selectedProject: project,
    provider: 'claude' as LLMProvider,
    canManageSettings: true,
    input: '',
    setInput: vi.fn(),
    textareaRef: { current: null },
    onExecuteCommand: vi.fn(),
  }));

  await waitFor(() => assert.equal(result.current.slashCommandsCount, 0));
  assert.deepEqual(result.current.filteredCommands, []);
  assert.equal(apiMocks.list.mock.calls.length, 0);
});
