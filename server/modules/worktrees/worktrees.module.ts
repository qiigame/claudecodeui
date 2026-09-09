import { access } from 'node:fs/promises';

import { projectsDb } from '@/modules/database/index.js';
import {
  createProject,
  deleteOrArchiveProject,
  restoreArchivedProject,
} from '@/modules/projects/index.js';
import type {
  WorktreeFileSystem,
  WorktreeProjectGateway,
  WorktreeServices,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import {
  captureDeploymentPolicy,
  type DeploymentPolicy,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import { createWorktree } from '@/modules/worktrees/services/worktree-create.service.js';
import { createAndOpenWorktree } from '@/modules/worktrees/services/worktree-create-and-open.service.js';
import { runGitCommand } from '@/modules/worktrees/services/worktree-git.service.js';
import { listWorktrees } from '@/modules/worktrees/services/worktree-list.service.js';
import { mergeWorktree } from '@/modules/worktrees/services/worktree-merge.service.js';
import { openWorktreeAsProject } from '@/modules/worktrees/services/worktree-open.service.js';
import { removeWorktree } from '@/modules/worktrees/services/worktree-remove.service.js';
import {
  configureSessionWorkspaceDeploymentPolicy,
  sessionWorkspaceService,
} from '@/modules/worktrees/services/session-workspace.service.js';
import { createWorktreesRouter } from '@/modules/worktrees/worktrees.routes.js';

/**
 * Startup-owned options for the Worktrees HTTP module.  The application
 * composition root supplies the immutable deployment policy so route guards
 * do not re-read mutable process environment state for every request.
 */
export type WorktreesModuleOptions = {
  deploymentPolicy?: DeploymentPolicySource;
};

/**
 * Real filesystem adapter used only by Worktrees production composition.
 *
 * Services depend on the shared capability type and therefore cannot touch a
 * developer's filesystem unless this adapter is explicitly supplied.
 */
const worktreeFileSystem: WorktreeFileSystem = {
  async pathExists(candidatePath: string): Promise<boolean> {
    try {
      await access(candidatePath);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Projects boundary for Worktrees production workflows.
 *
 * Imports are deliberately restricted to the Database and Projects barrel
 * files. No Worktrees service knows which repository or project service backs
 * these operations.
 */
const worktreeProjects: WorktreeProjectGateway = {
  getProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  getProjectByPath: (projectPath) => projectsDb.getProjectPath(projectPath),
  createProject: (input) => createProject(input),
  restoreProject: (projectId) => restoreArchivedProject(projectId),
  archiveProject: (projectId) => deleteOrArchiveProject(projectId, false),
};

const remove: WorktreeServices['remove'] = (input) => removeWorktree(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
});

const create: WorktreeServices['create'] = (input) => createWorktree(input, {
  runGit: runGitCommand,
  fileSystem: worktreeFileSystem,
});

const open: WorktreeServices['open'] = (input) => openWorktreeAsProject(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
});

/**
 * Production Worktrees application-service surface.
 *
 * This is the module's composition root: it is the only location that combines
 * concrete adapters with the independently testable workflow functions.
 */
const worktreeServices: WorktreeServices = {
  resolveProjectPath(projectId) {
    const projectPath = worktreeProjects.getProjectPathById(projectId);
    if (!projectPath) {
      throw new AppError(`Unable to resolve project path for "${projectId}"`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }

    return projectPath;
  },
  planSessionWorkspace: (projectPath) => sessionWorkspaceService.plan(projectPath),
  list: (input) => listWorktrees(input, {
    runGit: runGitCommand,
    getProjectByPath: worktreeProjects.getProjectByPath,
  }),
  create,
  createAndOpen: (input) => createAndOpenWorktree(input, {
    createWorktree: create,
    openWorktree: open,
    removeWorktree: remove,
  }),
  open,
  merge: (input) => {
    if (sessionWorkspaceService.isManagedWorkspacePath(input.projectPath)) {
      throw new AppError('Shared session worktrees must be merged through a protected PR or MR.', {
        code: 'TEAM_WORKTREE_MERGE_DISABLED',
        statusCode: 409,
      });
    }
    return mergeWorktree(input, {
      runGit: runGitCommand,
      removeWorktree: remove,
    });
  },
  remove: (input) => {
    if (sessionWorkspaceService.isManagedWorkspacePath(input.projectPath)) {
      throw new AppError('Session workspaces are retained until their safe archive checks pass.', {
        code: 'TEAM_WORKTREE_REMOVE_DISABLED',
        statusCode: 409,
      });
    }
    return remove(input);
  },
};

/**
 * Worktrees router mounted by the server entrypoint at `/api/worktrees`.
 *
 * It is assembled here so other modules consume only the Worktrees barrel and
 * cannot depend on route or service implementation files.
 */
/**
 * Creates the production Worktrees router with an optional startup policy.
 * Providers and Git share the same session-workspace service, while the
 * returned router owns only the HTTP capability boundary.
 */
export function createWorktreesModule(
  options: WorktreesModuleOptions = {},
) {
  const startupPolicy = captureDeploymentPolicy(options.deploymentPolicy);
  // Pin the same startup policy used by the HTTP guards into the shared
  // session-workspace service.  Providers imports that service directly, so
  // configuring it here closes the gap between route and service callers.
  // Keep the direct session-workspace service on the same snapshot as the
  // router, including for the legacy/default singleton. A later production
  // composition can replace this with its explicitly supplied startup policy.
  configureSessionWorkspaceDeploymentPolicy(startupPolicy);
  return createWorktreesRouter(worktreeServices, {
    deploymentPolicy: startupPolicy,
  });
}

/** Legacy router for standalone consumers that do not inject a policy. */
export const worktreesRoutes = createWorktreesModule();

/** Used by Providers and Git to provision sessions and protect shared baselines. */
export { sessionWorkspaceService };
