import { sessionDraftsDb, userDb, userPreferencesDb } from '@/modules/database/index.js';
import type { DeploymentPolicySource } from '@/modules/deployment-policy/index.js';

import { createUserRouter } from './user.routes.js';
import { createUserService } from './user.service.js';

const userService = createUserService({
  users: {
    getGitConfig: (userId) => userDb.getGitConfig(userId),
    updateGitConfig: (userId, gitName, gitEmail) => userDb.updateGitConfig(
      userId,
      gitName ?? '',
      gitEmail ?? '',
    ),
    completeOnboarding: (userId) => userDb.completeOnboarding(userId),
    hasCompletedOnboarding: (userId) => userDb.hasCompletedOnboarding(userId),
  },
  preferences: {
    getPreferences: (userId) => userPreferencesDb.getPreferences(userId),
    savePreferences: (userId, updates) => userPreferencesDb.savePreferences(userId, updates),
  },
  drafts: {
    getDrafts: (userId) => sessionDraftsDb.getDrafts(userId),
    saveDraft: (userId, scope, draft) => sessionDraftsDb.saveDraft(userId, scope, draft),
    deleteDraft: (userId, scope) => sessionDraftsDb.deleteDraft(userId, scope),
  },
});

/** Builds the User router with the composition root's startup policy. */
export function createUserModule(deploymentPolicy?: DeploymentPolicySource) {
  return createUserRouter(userService, { deploymentPolicy });
}

/** User router assembled for standalone consumers. */
export const userRoutes = createUserModule();
