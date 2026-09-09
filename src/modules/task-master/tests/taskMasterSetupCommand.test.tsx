import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import TaskMasterSetupModal from '@/modules/task-master/modals/TaskMasterSetupModal';
import type { TaskMasterProject } from '@/shared/types';

const shellState = vi.hoisted(() => ({ initialCommand: '' }));

vi.mock('@/modules/shell', () => ({
  Shell: ({ initialCommand }: { initialCommand: string }) => {
    shellState.initialCommand = initialCommand;
    return <div data-testid="taskmaster-shell" />;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  shellState.initialCommand = '';
});

test('TaskMaster setup launches the installed CLI without npm package resolution', () => {
  render(
    <TaskMasterSetupModal
      isOpen
      project={{
        projectId: 'project-1',
        path: '/workspace/project',
        fullPath: '/workspace/project',
        displayName: 'Project',
        isStarred: false,
        sessions: [],
      } as TaskMasterProject}
      onClose={() => undefined}
    />,
  );

  assert.equal(shellState.initialCommand, 'task-master init');
  assert.equal(shellState.initialCommand.includes('npx'), false);
});
