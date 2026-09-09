import * as fs from 'node:fs/promises';
import os from 'node:os';

import { projectsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory, normalizeProjectPath } from '@/shared/utils.js';

import { createCommandsRouter } from './commands.routes.js';

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = createCommandsRouter({
  fileSystem: fs,
  homeDirectory: os.homedir,
  appRoot: findApplicationRoot(getModuleDirectory(import.meta.url)),
  models: providerModelsService,
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
  // Command routes must resolve project paths through the DB registry rather
  // than trusting an absolute path supplied by a browser client.
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  resolveRegisteredProjectPath: (projectPath) => {
    const row = projectsDb.getProjectPath(normalizeProjectPath(projectPath));
    if (!row || row.isArchived) return null;
    // Session worktrees may intentionally live outside WORKSPACES_ROOT; DB
    // registration is the authority for this read-only command lookup.
    return row.project_path;
  },
});
