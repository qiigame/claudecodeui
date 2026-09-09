import { createRequire } from 'node:module';

import { getConnection, userDb } from '@/modules/database/index.js';

import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { dingTalkOAuthService } from './dingtalk-oauth.module.js';
import { AUTH_DEPLOYMENT_MODE } from './auth-policy.js';
import { canManageSettings } from './settings-access.middleware.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const databaseConnection = getConnection();
const SETTINGS_ADMIN_USER_IDS = process.env.CLOUDCLI_SETTINGS_ADMIN_USER_IDS;

const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash) => userDb.createUser(username, passwordHash),
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
  },
  transaction: {
    begin: () => databaseConnection.prepare('BEGIN').run(),
    commit: () => databaseConnection.prepare('COMMIT').run(),
    rollback: () => databaseConnection.prepare('ROLLBACK').run(),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  getSettingsPermission: (user) => canManageSettings(
    user,
    {
      configuredUserIds: SETTINGS_ADMIN_USER_IDS,
      deploymentProfile: AUTH_DEPLOYMENT_MODE.profile,
      requiresDingTalk: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
    },
  ),
  getDingTalkStatus: () => dingTalkOAuthService.getPublicStatus(),
  isPasswordLoginEnabled: () => AUTH_DEPLOYMENT_MODE.passwordLoginEnabled,
  getAuthMode: () => ({
    mode: AUTH_DEPLOYMENT_MODE.mode,
    requiresLogin: !AUTH_DEPLOYMENT_MODE.platformBypass,
    passwordLoginEnabled: AUTH_DEPLOYMENT_MODE.passwordLoginEnabled,
  }),
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken, dingTalkOAuthService);
