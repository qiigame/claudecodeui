import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectTaskMasterFolder,
  getProjectTaskMaster,
  getProjectTaskMasterById,
  projectTaskMasterResponse,
} from '@/modules/projects/services/projects-has-taskmaster.service.js';
import { AppError } from '@/shared/utils.js';

test('getProjectTaskMasterById returns null when project path is missing', async () => {
  const result = await getProjectTaskMasterById('project-1', {
    resolveProjectPathById: () => null,
    detectTaskMasterFolder: async () => {
      throw new Error('detectTaskMasterFolder should not be called when path is missing');
    },
  });

  assert.equal(result, null);
});

test('getProjectTaskMasterById returns configured status when taskmaster exists with essential files', async () => {
  const result = await getProjectTaskMasterById('project-1', {
    resolveProjectPathById: () => '/workspace/project-1',
    detectTaskMasterFolder: async () => ({
      hasTaskmaster: true,
      hasEssentialFiles: true,
      metadata: {
        taskCount: 3,
        subtaskCount: 0,
        completed: 1,
        pending: 2,
        inProgress: 0,
        review: 0,
        completionPercentage: 33,
        lastModified: '2026-01-01T00:00:00.000Z',
      },
    }),
  });

  assert.ok(result);
  assert.equal(result.projectId, 'project-1');
  assert.equal(result.projectPath, '/workspace/project-1');
  assert.equal(result.taskmaster.hasTaskmaster, true);
  assert.equal(result.taskmaster.hasEssentialFiles, true);
  assert.equal(result.taskmaster.status, 'configured');
  assert.deepEqual(result.taskmaster.metadata, {
    taskCount: 3,
    subtaskCount: 0,
    completed: 1,
    pending: 2,
    inProgress: 0,
    review: 0,
    completionPercentage: 33,
    lastModified: '2026-01-01T00:00:00.000Z',
  });
});

test('projectTaskMasterResponse omits the server-local path for managed callers', () => {
  const details = {
    projectId: 'project-1',
    projectPath: '/srv/cloudcli/projects-ro/project-1',
    taskmaster: {
      hasTaskmaster: true,
      hasEssentialFiles: true,
      metadata: null,
      status: 'configured' as const,
    },
  };

  assert.deepEqual(projectTaskMasterResponse(details, { includeProjectPath: false }), {
    projectId: 'project-1',
    taskmaster: details.taskmaster,
  });
  assert.equal(
    JSON.stringify(projectTaskMasterResponse(details, { includeProjectPath: false }))
      .includes('/srv/cloudcli'),
    false,
  );

  // Existing self-hosted/developer callers retain the legacy field unless a
  // route explicitly selects the managed projection.
  assert.equal(projectTaskMasterResponse(details).projectPath, details.projectPath);
});

test('getProjectTaskMasterById returns not-configured status when taskmaster is missing', async () => {
  const result = await getProjectTaskMasterById('project-1', {
    resolveProjectPathById: () => '/workspace/project-1',
    detectTaskMasterFolder: async () => ({
      hasTaskmaster: false,
    }),
  });

  assert.ok(result);
  assert.equal(result.taskmaster.hasTaskmaster, false);
  assert.equal(result.taskmaster.hasEssentialFiles, false);
  assert.equal(result.taskmaster.status, 'not-configured');
  assert.equal(result.taskmaster.metadata, null);
});

test('getProjectTaskMaster throws when project id is missing', async () => {
  await assert.rejects(
    async () =>
      getProjectTaskMaster('', async () => ({
        projectId: 'project-1',
        projectPath: '/workspace/project-1',
        taskmaster: {
          hasTaskmaster: true,
          hasEssentialFiles: true,
          metadata: null,
          status: 'configured',
        },
      })),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROJECT_ID_REQUIRED');
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test('getProjectTaskMaster throws when project does not exist', async () => {
  await assert.rejects(
    async () => getProjectTaskMaster('project-that-does-not-exist', async () => null),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROJECT_NOT_FOUND');
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test('TaskMaster detection ignores a .taskmaster symlink outside the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-detect-'));
  const projectPath = path.join(root, 'project');
  const outsidePath = path.join(root, 'outside-taskmaster');

  try {
    await mkdir(projectPath, { recursive: true });
    await mkdir(path.join(outsidePath, 'tasks'), { recursive: true });
    await writeFile(
      path.join(outsidePath, 'tasks', 'tasks.json'),
      JSON.stringify({ tasks: [{ id: 1, status: 'done' }] }),
      'utf8',
    );
    await symlink(outsidePath, path.join(projectPath, '.taskmaster'), 'dir');

    const result = await detectTaskMasterFolder(projectPath);

    assert.equal(result.hasTaskmaster, false);
    assert.match(result.reason ?? '', /outside the project root/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TaskMaster detection ignores a tasks.json symlink outside the project', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-detect-file-'));
  const projectPath = path.join(root, 'project');
  const taskMasterPath = path.join(projectPath, '.taskmaster');
  const outsideTasksPath = path.join(root, 'outside-tasks.json');

  try {
    await mkdir(path.join(taskMasterPath, 'tasks'), { recursive: true });
    await writeFile(outsideTasksPath, JSON.stringify({ tasks: [{ id: 1 }] }), 'utf8');
    await symlink(outsideTasksPath, path.join(taskMasterPath, 'tasks', 'tasks.json'));

    const result = await detectTaskMasterFolder(projectPath);

    assert.equal(result.hasTaskmaster, true);
    assert.equal(result.files?.['tasks/tasks.json'], false);
    assert.equal(result.hasEssentialFiles, false);
    assert.equal(result.metadata, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
