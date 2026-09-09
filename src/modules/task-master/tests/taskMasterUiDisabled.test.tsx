import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

const installationStatus = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api', () => ({
  api: {
    taskmaster: { installationStatus },
    user: { savePreferences: vi.fn(async () => ({ ok: true })) },
  },
}));

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    taskMasterUiEnabled: false,
  };
});

const { TasksSettingsProvider, useTasksSettings } = await import(
  '@/modules/task-master/context/TasksSettingsContext'
);
const { resetUserPreferences, writeUserPreference } = await import('@/shared/userSettings');

function TasksStateProbe() {
  const {
    tasksEnabled,
    setTasksEnabled,
    isTaskMasterInstalled,
    isTaskMasterReady,
    isCheckingInstallation,
  } = useTasksSettings();

  return (
    <button type="button" onClick={() => setTasksEnabled(true)}>
      {JSON.stringify({
        tasksEnabled,
        isTaskMasterInstalled,
        isTaskMasterReady,
        isCheckingInstallation,
      })}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  installationStatus.mockClear();
});

afterEach(() => {
  cleanup();
  resetUserPreferences();
});

test('a disabled TaskMaster build ignores saved opt-in state and skips installation checks', async () => {
  writeUserPreference('tasksEnabled', true);

  render(
    <TasksSettingsProvider>
      <TasksStateProbe />
    </TasksSettingsProvider>,
  );

  const probe = screen.getByRole('button');

  await waitFor(() => {
    assert.deepEqual(JSON.parse(probe.textContent || '{}'), {
      tasksEnabled: false,
      isTaskMasterInstalled: false,
      isTaskMasterReady: false,
      isCheckingInstallation: false,
    });
  });
  assert.equal(installationStatus.mock.calls.length, 0);

  fireEvent.click(probe);
  assert.equal(JSON.parse(probe.textContent || '{}').tasksEnabled, false);
});
