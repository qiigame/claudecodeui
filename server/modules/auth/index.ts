// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';

// resolveAuthDeploymentMode: used by the server composition root and
// websocket gateway to distinguish legacy platform bypass from SSO sessions.
export {
  AUTH_DEPLOYMENT_MODE,
  extractBearerToken,
  resolveAuthDeploymentMode,
  type AuthDeploymentMode,
} from './auth-policy.js';

// createSettingsAdminRouteGuard: used by the server entrypoint to protect configuration mutations.
export {
  createSettingsAdminRouteGuard,
  normalizeRoutePath,
} from './settings-access.middleware.js';
