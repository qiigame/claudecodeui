import fs from 'node:fs';
import path from 'node:path';

import type { Request } from 'express';
import mime from 'mime-types';

// Import the pure startup auth policy directly instead of the Auth barrel: the
// barrel also composes bcrypt/database-backed routes, which would introduce a
// needless initialization cycle for standalone plugin embedders.
import { AUTH_DEPLOYMENT_MODE } from '@/modules/auth/auth-policy.js';
import { collaborationService } from '@/modules/collaboration/index.js';
import { projectsDb } from '@/modules/database/index.js';
import type { DeploymentPolicy } from '@/modules/deployment-policy/index.js';
import {
  AppError,
  normalizeProjectPath,
  readAuthenticatedHttpUserId,
} from '@/shared/utils.js';

import {
  getPluginDir, getPluginsConfig, getPluginsDir, installPluginFromGit,
  resolvePluginAssetPath, savePluginsConfig, scanPlugins, uninstallPlugin, updatePluginFromGit,
} from './plugin-registry.service.js';
import {
  getPluginPort, isPluginRunning, startPluginServer, stopPluginServer,
} from './plugin-process.service.js';
import { createPluginsRouter } from './plugins.routes.js';
import { createPluginsService } from './plugins.service.js';

const pluginsService = createPluginsService({
  scanPlugins, readConfig: getPluginsConfig, saveConfig: savePluginsConfig,
  getPluginDirectory: getPluginDir, getPluginsDirectory: getPluginsDir,
  resolveAsset: resolvePluginAssetPath,
  assetIsFile: (assetPath) => { try { return fs.statSync(assetPath).isFile(); } catch { return false; } },
  contentType: (assetPath) => mime.lookup(assetPath) || 'application/octet-stream',
  install: installPluginFromGit,
  update: updatePluginFromGit,
  uninstall: async (pluginName) => { await uninstallPlugin(pluginName); },
  startServer: startPluginServer,
  stopServer: async (pluginName) => { await stopPluginServer(pluginName); },
  getServerPort: getPluginPort, isServerRunning: isPluginRunning,
  getActiveProjectPaths: () => projectsDb.getProjectPaths().map((project) => project.project_path),
  normalizeProjectPath,
  joinPath: path.join,
  logError: (message, error) => console.error(message, error),
});

/**
 * Revalidates the current DingTalk actor immediately before a plugin RPC is
 * proxied.  The legacy/default router is exported for standalone embedders
 * and tests, so it cannot rely on server/index.ts' policy-aware composition
 * to provide this check.  Keep the callback opt-in for local developer
 * deployments: a local password account must retain its historical plugin
 * workflow even when a stale registry file happens to exist in the shell.
 */
function assertVerifiedDingTalkActor(request: Request): void {
  const userId = readAuthenticatedHttpUserId(request);
  const actor = collaborationService.getActorByUserId(userId);
  if (actor?.provider !== 'dingtalk'
    || actor.identityStatus !== 'verified'
    || !actor.personId) {
    throw new AppError(
      'Your project identity is pending registration. Read-only access remains available.',
      { code: 'IDENTITY_ENROLLMENT_REQUIRED', statusCode: 403 },
    );
  }
  // A cached actor row is not sufficient for an execution boundary: this
  // assertion re-resolves the registry subject and fails closed when the
  // managed registry is missing, invalid, suspended, or ambiguous.
  collaborationService.assertActorCanWrite(userId, { requireRegistry: true });
}

/** Plugin router assembled with filesystem, loader, and process adapters. */
export const pluginsRoutes = createPluginsRouter(pluginsService, {
  // Preserve the standalone/local developer behavior while hardening a
  // managed DingTalk composition that mounts this compatibility export
  // directly instead of calling createPluginsModule().
  assertActorCanUsePlugins: AUTH_DEPLOYMENT_MODE.requiresDingTalk
    ? assertVerifiedDingTalkActor
    : undefined,
});

/**
 * Builds the production Plugins router with the startup deployment policy.
 * Plugin RPC and management handlers otherwise fall back to parsing process
 * environment on demand, which could diverge from the policy used for
 * startup subprocess decisions after a runtime env mutation.
 */
export type PluginsModuleOptions = {
  /** Require the current DingTalk project actor before any plugin RPC executes. */
  requireVerifiedDingTalkActor?: boolean;
};

export function createPluginsModule(
  deploymentPolicy: DeploymentPolicy,
  options: PluginsModuleOptions = {},
): ReturnType<typeof createPluginsRouter> {
  // The normal composition root passes this flag explicitly.  Keep the
  // standalone factory fail-closed as well: an explicit DingTalk auth startup
  // declaration must not be neutralized merely because an embedder omitted
  // the newer option while selecting a writable `developer` profile.
  const requireVerifiedDingTalkActor = options.requireVerifiedDingTalkActor === true
    || AUTH_DEPLOYMENT_MODE.requiresDingTalk;
  return createPluginsRouter(pluginsService, {
    deploymentPolicy,
    assertActorCanUsePlugins: requireVerifiedDingTalkActor
      ? assertVerifiedDingTalkActor
      : undefined,
  });
}
