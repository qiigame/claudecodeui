import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';

import { Octokit } from '@octokit/rest';
import spawn from 'cross-spawn';

import {
  apiKeysDb,
  githubTokensDb,
  projectsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  collaborationService,
  executionAttributionService,
} from '@/modules/collaboration/index.js';
import { AUTH_DEPLOYMENT_MODE } from '@/modules/auth/index.js';
import type { DeploymentPolicy } from '@/modules/deployment-policy/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

import { createAgentRouter } from './agent.routes.js';

type AgentExternalDependencies = Pick<
  Parameters<typeof createAgentRouter>[0],
  'queryClaude' | 'queryCursor' | 'queryCodex' | 'queryOpenCode'
>;

export type AgentModuleOptions = AgentExternalDependencies & {
  /** Startup-resolved policy shared with all other execution boundaries. */
  deploymentPolicy?: DeploymentPolicy;
};

/**
 * Assembles the production Agent router while accepting provider runners from
 * the centralized provider runtime service.
 */
export function createAgentModule(externalDependencies: AgentModuleOptions) {
  return createAgentRouter({
    fileSystem: fs,
    crypto,
    homeDirectory: os.homedir,
    spawnProcess: spawn,
    // Only the auth policy may authorize the legacy first-user principal.
    // `VITE_IS_PLATFORM` is a presentation/hosting hint and is deliberately
    // not passed as an authentication bypass to the Agent router.
    platformMode: false,
    allowUnauthenticatedPlatform: AUTH_DEPLOYMENT_MODE.platformBypass,
    // DingTalk intent is an independent startup boundary from the deployment
    // profile. A writable developer profile may still require verified SSO,
    // while legacy platform mode without SSO must keep its first-user path.
    requireVerifiedActor: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
    users: {
      getFirstUser: () => userDb.getFirstUser(),
    },
    apiKeys: {
      validateApiKey: (apiKey) => apiKeysDb.validateApiKey(apiKey),
    },
    githubTokens: {
      getActiveGithubToken: (userId) => githubTokensDb.getActiveGithubToken(userId),
    },
    projects: {
      createProjectPath: (projectPath, customName) =>
        projectsDb.createProjectPath(projectPath, customName),
    },
    assertActorCanWrite: (userId) => {
      // The legacy Agent API authenticates with an API key rather than the
      // normal JWT middleware. In a DingTalk deployment it therefore needs an
      // explicit provider check here; otherwise a local API-key account could
      // bypass the SSO principal gate and reach clone/provider/Git side
      // effects. Local developer deployments retain their normal account
      // behavior, even when a coordination registry snapshot is present.
      if (AUTH_DEPLOYMENT_MODE.requiresDingTalk) {
        const actor = collaborationService.getActorByUserId(userId);
        if (!actor || actor.provider !== 'dingtalk') {
          throw new AppError('A verified DingTalk project identity is required for Agent execution.', {
            code: 'IDENTITY_ENROLLMENT_REQUIRED',
            statusCode: 403,
          });
        }
      }
      collaborationService.assertActorCanWrite(userId, {
        // Keep standalone Agent-router composition fail-closed for managed
        // DingTalk, even when it is mounted without server/index.ts's startup
        // identity-policy pin. Local developer mode deliberately passes false.
        requireRegistry: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
      });
    },
    executionAttribution: executionAttributionService,
    models: providerModelsService,
    GithubClient: Octokit,
    ...externalDependencies,
  });
}
