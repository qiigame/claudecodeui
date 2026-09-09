import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

type TaskMasterTask = {
  status?: string;
  subtasks?: Array<{
    status?: string;
  }>;
};

type TaskMasterMetadata =
  | {
      taskCount: number;
      subtaskCount: number;
      completed: number;
      pending: number;
      inProgress: number;
      review: number;
      completionPercentage: number;
      lastModified: string;
    }
  | {
      error: string;
    }
  | null;

type TaskMasterDetectionResult = {
  hasTaskmaster: boolean;
  hasEssentialFiles?: boolean;
  files?: Record<string, boolean>;
  metadata?: TaskMasterMetadata;
  path?: string;
  reason?: string;
};

type NormalizedTaskMasterInfo = {
  hasTaskmaster: boolean;
  hasEssentialFiles: boolean;
  metadata: TaskMasterMetadata;
  status: 'configured' | 'not-configured';
};

/** Internal TaskMaster details resolved from the project registry. */
export type ProjectTaskMasterDetails = {
  projectId: string;
  projectPath: string;
  taskmaster: NormalizedTaskMasterInfo;
};

/**
 * Public TaskMaster details returned by project routes.  The project path is
 * optional because managed/read-only callers only need the project id and
 * status metadata; local developer callers may retain the legacy field.
 */
export type ProjectTaskMasterResponse = Omit<ProjectTaskMasterDetails, 'projectPath'> & {
  projectPath?: string;
};

/** Options controlling which deployment-owned details a project response exposes. */
export type ProjectTaskMasterResponseOptions = {
  /** Preserve the legacy absolute projectPath field for an explicitly local developer caller. */
  includeProjectPath?: boolean;
};

type GetProjectTaskMasterDependencies = {
  resolveProjectPathById: (projectId: string) => string | null;
  detectTaskMasterFolder: (projectPath: string) => Promise<TaskMasterDetectionResult>;
};

type GetProjectTaskMasterResolver = (projectId: string) => Promise<ProjectTaskMasterDetails | null>;

function extractTasksFromJson(tasksData: unknown): TaskMasterTask[] {
  if (!tasksData || typeof tasksData !== 'object') {
    return [];
  }

  const legacyTasks = (tasksData as { tasks?: unknown }).tasks;
  if (Array.isArray(legacyTasks)) {
    return legacyTasks as TaskMasterTask[];
  }

  const taggedTaskCollections: TaskMasterTask[] = [];
  for (const tagValue of Object.values(tasksData)) {
    if (!tagValue || typeof tagValue !== 'object') {
      continue;
    }

    const tagTasks = (tagValue as { tasks?: unknown }).tasks;
    if (Array.isArray(tagTasks)) {
      taggedTaskCollections.push(...(tagTasks as TaskMasterTask[]));
    }
  }

  return taggedTaskCollections;
}

export async function detectTaskMasterFolder(projectPath: string): Promise<TaskMasterDetectionResult> {
  try {
    // Project paths come from the DB. Resolve both the project and
    // `.taskmaster` directory before opening any child so a stale symlink in
    // the checkout cannot redirect this metadata reader outside the selected
    // project. (The route is read-only, but this data is still user-visible.)
    const canonicalProjectPath = await realpath(projectPath);
    const lexicalTaskMasterPath = path.join(canonicalProjectPath, '.taskmaster');
    const taskMasterPath = await realpath(lexicalTaskMasterPath);
    const relativeTaskMasterPath = path.relative(canonicalProjectPath, taskMasterPath);
    if (
      !relativeTaskMasterPath
      || relativeTaskMasterPath === '..'
      || relativeTaskMasterPath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeTaskMasterPath)
    ) {
      return {
        hasTaskmaster: false,
        reason: '.taskmaster path resolves outside the project root',
      };
    }

    try {
      const taskMasterStats = await stat(taskMasterPath);
      if (!taskMasterStats.isDirectory()) {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster exists but is not a directory',
        };
      }
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code === 'ENOENT') {
        return {
          hasTaskmaster: false,
          reason: '.taskmaster directory not found',
        };
      }

      throw fileError;
    }

    const keyFiles = ['tasks/tasks.json', 'config.json'];
    const fileStatus: Record<string, boolean> = {};
    let hasEssentialFiles = true;

    for (const fileName of keyFiles) {
      const lexicalFilePath = path.join(taskMasterPath, fileName);
      let absoluteFilePath: string;
      try {
        absoluteFilePath = await realpath(lexicalFilePath);
        const relativeFilePath = path.relative(canonicalProjectPath, absoluteFilePath);
        if (
          !relativeFilePath
          || relativeFilePath === '..'
          || relativeFilePath.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativeFilePath)
        ) {
          fileStatus[fileName] = false;
          if (fileName === 'tasks/tasks.json') {
            hasEssentialFiles = false;
          }
          continue;
        }
      } catch {
        fileStatus[fileName] = false;
        if (fileName === 'tasks/tasks.json') {
          hasEssentialFiles = false;
        }
        continue;
      }
      try {
        await access(absoluteFilePath);
        fileStatus[fileName] = true;
      } catch {
        fileStatus[fileName] = false;
        if (fileName === 'tasks/tasks.json') {
          hasEssentialFiles = false;
        }
      }
    }

    let taskMetadata: TaskMasterMetadata = null;
    if (fileStatus['tasks/tasks.json']) {
      // Resolve again immediately before the read and use the canonical path
      // returned by realpath, avoiding a second traversal through a swapped
      // symlink. The file was already validated in the key-file pass; a race
      // simply degrades to the existing parse-error response.
      let tasksPath: string;
      try {
        tasksPath = await realpath(path.join(taskMasterPath, 'tasks/tasks.json'));
        const relativeTasksPath = path.relative(canonicalProjectPath, tasksPath);
        if (
          !relativeTasksPath
          || relativeTasksPath === '..'
          || relativeTasksPath.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativeTasksPath)
        ) {
          throw new Error('tasks path outside project root');
        }
      } catch (error) {
        console.warn('Failed to resolve tasks.json safely:', (error as Error).message);
        taskMetadata = { error: 'Failed to parse tasks.json' };
        return {
          hasTaskmaster: true,
          hasEssentialFiles: false,
          files: fileStatus,
          metadata: taskMetadata,
          path: taskMasterPath,
        };
      }
      try {
        const tasksContent = await readFile(tasksPath, 'utf8');
        const parsedTasksJson = JSON.parse(tasksContent) as unknown;
        const tasks = extractTasksFromJson(parsedTasksJson);

        const stats = tasks.reduce(
          (accumulator, currentTask) => {
            accumulator.total += 1;
            const normalizedTaskStatus = currentTask.status || 'pending';
            accumulator.byStatus[normalizedTaskStatus] = (accumulator.byStatus[normalizedTaskStatus] || 0) + 1;

            if (Array.isArray(currentTask.subtasks)) {
              for (const subtask of currentTask.subtasks) {
                accumulator.subtotalTasks += 1;
                const normalizedSubtaskStatus = subtask.status || 'pending';
                accumulator.subtaskByStatus[normalizedSubtaskStatus] =
                  (accumulator.subtaskByStatus[normalizedSubtaskStatus] || 0) + 1;
              }
            }

            return accumulator;
          },
          {
            total: 0,
            subtotalTasks: 0,
            byStatus: {} as Record<string, number>,
            subtaskByStatus: {} as Record<string, number>,
          },
        );

        const tasksStat = await stat(tasksPath);
        taskMetadata = {
          taskCount: stats.total,
          subtaskCount: stats.subtotalTasks,
          completed: stats.byStatus.done || 0,
          pending: stats.byStatus.pending || 0,
          inProgress: stats.byStatus['in-progress'] || 0,
          review: stats.byStatus.review || 0,
          completionPercentage: stats.total > 0 ? Math.round(((stats.byStatus.done || 0) / stats.total) * 100) : 0,
          lastModified: tasksStat.mtime.toISOString(),
        };
      } catch (parseError) {
        console.warn('Failed to parse tasks.json:', (parseError as Error).message);
        taskMetadata = {
          error: 'Failed to parse tasks.json',
        };
      }
    }

    return {
      hasTaskmaster: true,
      hasEssentialFiles,
      files: fileStatus,
      metadata: taskMetadata,
      path: taskMasterPath,
    };
  } catch (error) {
    console.error('Error detecting TaskMaster folder:', error);
    return {
      hasTaskmaster: false,
      reason: `Error checking directory: ${(error as Error).message}`,
    };
  }
}

function normalizeTaskMasterInfo(taskMasterResult: TaskMasterDetectionResult | null = null): NormalizedTaskMasterInfo {
  const hasTaskmaster = Boolean(taskMasterResult?.hasTaskmaster);
  const hasEssentialFiles = Boolean(taskMasterResult?.hasEssentialFiles);

  return {
    hasTaskmaster,
    hasEssentialFiles,
    metadata: taskMasterResult?.metadata ?? null,
    status: hasTaskmaster && hasEssentialFiles ? 'configured' : 'not-configured',
  };
}

const defaultDependencies: GetProjectTaskMasterDependencies = {
  resolveProjectPathById: (projectId: string): string | null => projectsDb.getProjectPathById(projectId),
  detectTaskMasterFolder,
};

export async function getProjectTaskMasterById(
  projectId: string,
  dependencies: GetProjectTaskMasterDependencies = defaultDependencies,
): Promise<ProjectTaskMasterDetails | null> {
  const projectPath = dependencies.resolveProjectPathById(projectId);
  if (!projectPath) {
    return null;
  }

  const taskMasterResult = await dependencies.detectTaskMasterFolder(projectPath);
  return {
    projectId,
    projectPath,
    taskmaster: normalizeTaskMasterInfo(taskMasterResult),
  };
}

/**
 * Projects routes use this projection before serializing TaskMaster details.
 * `projectPath` is a server-local absolute path and must be omitted for
 * product/QA or managed callers; the default keeps existing local developer
 * consumers source-compatible until they opt into the safer projection.
 */
export function projectTaskMasterResponse(
  details: ProjectTaskMasterDetails,
  options: ProjectTaskMasterResponseOptions = {},
): ProjectTaskMasterResponse {
  if (options.includeProjectPath !== false) {
    return { ...details };
  }

  const { projectPath: _projectPath, ...safeDetails } = details;
  return safeDetails;
}

export async function getProjectTaskMaster(
  projectId: string,
  resolveById: GetProjectTaskMasterResolver = getProjectTaskMasterById,
): Promise<ProjectTaskMasterDetails> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    throw new AppError('projectId is required', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const taskMasterDetails = await resolveById(normalizedProjectId);
  if (!taskMasterDetails) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  return taskMasterDetails;
}
