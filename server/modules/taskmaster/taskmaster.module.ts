import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { createDeploymentPolicyGuard } from '@/modules/deployment-policy/index.js';

import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getHomeDirectory: os.homedir,
});

/** Used by the server entrypoint to mount authenticated TaskMaster endpoints. */
export const taskmasterRoutes = createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  spawnProcess: spawn,
  taskmasterCliCommand: process.env.TASKMASTER_CLI_PATH || 'task-master',
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  taskmasterService,
  // Keep the capability boundary inside the feature router as well as at the
  // application mount.  The server composition root attaches its immutable
  // startup policy to each request, so this guard uses that snapshot in
  // production; standalone/alternate mounts fall back to the trusted process
  // policy instead of silently exposing TaskMaster writes.
  capabilityGuard: (operation) => createDeploymentPolicyGuard({ capability: operation }),
});
