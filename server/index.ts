#!/usr/bin/env node
// Load environment variables before other imports execute.
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';

import express, {
    type NextFunction,
    type Request,
    type RequestHandler,
    type Response,
} from 'express';
import cors from 'cors';

import { AppError, findApplicationRoot, getModuleDirectory, terminalTextStyles } from '@/shared/utils.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    createProviderRouter,
    createProviderRuntimeService,
} from '@/modules/providers/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { createGitModule } from './modules/git/index.js';
import {
    authenticateToken,
    authenticateWebSocket,
    AUTH_DEPLOYMENT_MODE,
    authRoutes,
    createSettingsAdminRouteGuard,
    normalizeRoutePath,
    validateApiKey,
} from './modules/auth/index.js';
import { taskmasterRoutes } from './modules/taskmaster/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { createSettingsModule } from './modules/settings/index.js';
import { createSystemModule } from './modules/system/index.js';
import { createAgentModule } from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import { createNotificationsRouter } from './modules/notifications/notifications.routes.js';
import { createUserModule } from './modules/user/index.js';
import {
    canStartEnabledPluginServers,
    createPluginsModule,
    getPluginPort,
    startEnabledPluginServers,
    stopAllPlugins,
} from './modules/plugins/index.js';
import { createVoiceModule } from './modules/voice/index.js';
import {
  closeScheduledMessageDispatcher,
  createScheduledMessagesRouter,
  initializeScheduledMessageDispatcher,
} from './modules/scheduled-messages/index.js';
import { createBrowserUseRouter } from './modules/browser-use/browser-use.routes.js';
import { createAssetsRouter } from './modules/assets/index.js';
import { createFileTreeModule } from './modules/file-tree/index.js';
import {
    createWorktreesModule,
    sessionWorkspaceService,
} from './modules/worktrees/index.js';
import {
    createBrowserUseMcpRouter,
    mountBrowserUseMcpBridgeBeforeApiKey,
} from './modules/browser-use/browser-use-mcp.routes.js';
import {
    browserUseService,
    reconcileBrowserUseMcpRegistrationOnStartup,
} from './modules/browser-use/browser-use.service.js';
import { initializeDatabase, sessionsDb } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';
import {
  configureIdentityRegistryRequirement,
  createCollaborationModule,
  createInternalCommitReceiptModule,
  identityRegistryService,
  publicSharePageHeaders,
  publicShareRoutes,
} from './modules/collaboration/index.js';
import {
    DEPLOYMENT_CAPABILITIES,
    createDeploymentPolicyContextMiddleware,
    createDeploymentPolicyGuard,
    hasDeploymentCapability,
    isDeploymentReadOnly,
    mountProtectedApiRoute,
    mountPreApiKeyCapabilityRoute,
    parseDeploymentPolicy,
    resolveDefaultPermissionMode,
} from './modules/deployment-policy/index.js';

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Resolve the trusted deployment policy before composing any feature module.
// Auth has its own immutable mode snapshot, but all capability/update wiring
// must use this same startup policy rather than reparsing process.env later.
const deploymentPolicy = parseDeploymentPolicy();
const defaultPermissionMode = resolveDefaultPermissionMode(deploymentPolicy);
// Provider execution is composed from the same immutable startup snapshot as
// the HTTP/WebSocket capability guards. Keeping this instance local to the
// composition root prevents a direct runtime caller from silently selecting a
// different (or writable) policy after process startup.
const providerRuntimeService = createProviderRuntimeService({ deploymentPolicy });
// Pin the identity-registry requirement alongside the startup deployment and
// auth policies. This keeps every collaboration/execution boundary fail
// closed if a managed DingTalk deployment forgot the legacy env switch, while
// an explicit local developer profile remains unaffected by stale registry
// files in the shell environment.
configureIdentityRegistryRequirement(
    AUTH_DEPLOYMENT_MODE.requiresDingTalk
    || process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED === '1',
);
// An explicit DingTalk declaration is authoritative even when an operator
// selects a writable `developer` profile. That combination is useful for a
// local SSO-backed development instance, but pending/ambiguous actors must
// still be unable to execute providers, PTYs, or plugins.
const managedSsoActorGate = AUTH_DEPLOYMENT_MODE.requiresDingTalk;
// Startup reconciliation can write provider MCP configuration and launch
// third-party plugin subprocesses before an HTTP actor exists.  In a managed
// DingTalk deployment those are operator-approved side effects, not ordinary
// process boot work: keep them disabled until the deployment administrator
// explicitly flips this protected, process-startup-only switch after the
// runtime identity map has been verified.
const managedStartupSideEffectsApproved = process.env.CLOUDCLI_IDENTITY_STARTUP_APPROVED === '1';

/**
 * Plugin startup is an execution side effect even before an HTTP principal
 * exists.  A managed DingTalk process therefore needs a valid identity
 * registry before an enabled third-party plugin can be launched.  Keep this
 * preflight local to the composition root; ordinary developer deployments do
 * not consult a registry merely because one happens to be present in their
 * shell environment.
 */
const managedIdentityReadyForStartup = (): boolean => {
    if (!managedSsoActorGate) return true;
    if (!managedStartupSideEffectsApproved) {
        console.error('[IdentityRegistry] Browser MCP and plugin startup skipped until CLOUDCLI_IDENTITY_STARTUP_APPROVED=1 is provisioned after runtime identity verification.');
        return false;
    }
    try {
        identityRegistryService.assertConfiguration({ required: true });
        return true;
    } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code ?? 'IDENTITY_REGISTRY_INVALID')
            : 'IDENTITY_REGISTRY_INVALID';
        console.error('[IdentityRegistry] Plugin startup skipped because the managed registry is unavailable.', code);
        return false;
    }
};
// Capture the managed settings-admin allowlist at the same startup boundary;
// route middleware must not observe changes to process.env after composition.
const settingsAccessPolicy = {
    deploymentProfile: deploymentPolicy.profile,
    requiresDingTalk: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
    configuredUserIds: process.env.CLOUDCLI_SETTINGS_ADMIN_USER_IDS,
} as const;
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const systemRoutes = createSystemModule({
    appRoot: APP_ROOT,
    installMode,
    // System update behavior is selected from the trusted server deployment
    // profile.  The browser/build-time VITE_IS_PLATFORM flag is not an auth
    // or update authority and may be stale in a developer/production build.
    isPlatform: deploymentPolicy.profile === 'platform',
    deploymentPolicy,
});
console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();
const server = http.createServer(app);

// Deployment policy is resolved once at process startup. Route modules keep
// their standalone/test constructors intact and receive this resolver only
// from the production composition root. The policy service supplies writable
// capabilities for legacy developer/self-hosted profiles and read-only
// capabilities for product/QA (and hosted) profiles.
const deploymentCapabilityGuard = (operation: string): RequestHandler => {
    return createDeploymentPolicyGuard({
        policy: deploymentPolicy,
        capability: operation,
        // Keep the same stable error contract as service-level and websocket
        // capability checks.  A single code lets the UI and API clients
        // handle a denied operation consistently regardless of route.
        errorCode: 'DEPLOYMENT_CAPABILITY_DENIED',
        message: 'This operation is not enabled for the current deployment.',
    });
};

const READ_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Applies a deployment capability only to HTTP mutations.  Most feature
 * routers deliberately keep their read endpoints available to product/QA;
 * putting this middleware ahead of the router also guarantees that a denied
 * request cannot reach a process spawn, filesystem write, or external side
 * effect in the handler.
 */
const createMutationCapabilityGuard = (operation: string): RequestHandler => {
    const guard = deploymentCapabilityGuard(operation);
    return (request, response, next) => {
        if (READ_HTTP_METHODS.has(request.method.toUpperCase())) {
            next();
            return;
        }
        guard(request, response, next);
    };
};

/** Settings has a small safe subset (personal notification preferences and
 * push subscriptions) that remains usable in a read-only code deployment.
 * API keys and provider credentials are deployment configuration and require
 * the stronger settings.write capability in addition to the admin guard.
 */
const settingsMutationCapabilityGuard: RequestHandler = (request, response, next) => {
    if (READ_HTTP_METHODS.has(request.method.toUpperCase())) {
        next();
        return;
    }
    // Express route matching is case-insensitive and accepts a trailing slash.
    // Classify the canonical route before selecting the capability so a
    // personal-safe endpoint cannot be accidentally treated as a settings
    // write (or vice versa) merely because a client used different casing.
    const routePath = normalizeRoutePath(request.path);
    const method = request.method.toUpperCase();
    const personalNotificationMutation = (method === 'PUT'
        && routePath === '/notification-preferences')
        || (method === 'POST'
            && (routePath === '/push/subscribe' || routePath === '/push/unsubscribe'));
    const operation = personalNotificationMutation
        ? DEPLOYMENT_CAPABILITIES.SESSION_WRITE
        : DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE;
    deploymentCapabilityGuard(operation)(request, response, next);
};

/** Git identity is deployment configuration; onboarding/preferences/drafts
 * are per-user application state and do not grant repository access. */
const userMutationCapabilityGuard: RequestHandler = (request, response, next) => {
    if (READ_HTTP_METHODS.has(request.method.toUpperCase())) {
        next();
        return;
    }
    const routePath = normalizeRoutePath(request.path);
    const method = request.method.toUpperCase();
    const personalMutation = (method === 'POST'
        && routePath === '/complete-onboarding')
        || (method === 'PATCH'
            && routePath === '/preferences')
        || ((method === 'PUT' || method === 'DELETE')
            && routePath === '/drafts');
    const operation = routePath === '/git-config' || !personalMutation
        ? DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE
        : DEPLOYMENT_CAPABILITIES.SESSION_WRITE;
    deploymentCapabilityGuard(operation)(request, response, next);
};

const taskmasterMutationGuard = createMutationCapabilityGuard(
    DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
);
// Chat attachments are intentionally allowed in the product/QA profile, but
// the upload boundary still has to be explicit so a deployment that omits
// `attachment.upload` cannot write into the global assets directory.
const attachmentUploadGuard = createMutationCapabilityGuard(
    DEPLOYMENT_CAPABILITIES.ATTACHMENT_UPLOAD,
);
const browserMutationGuard = createMutationCapabilityGuard(
    DEPLOYMENT_CAPABILITIES.BROWSER_USE,
);
const systemMutationGuard = createMutationCapabilityGuard(
    DEPLOYMENT_CAPABILITIES.SETTINGS_WRITE,
);
const notificationMutationGuard = createMutationCapabilityGuard(
    DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
);
// Keep the notification router's own write boundary aligned with the same
// startup-resolved policy as the outer mutation guard.  This also protects
// alternate mounts that reuse the router without the application wrapper.
const notificationRoutes = createNotificationsRouter({
    capabilityGuard: deploymentCapabilityGuard,
});
// Scheduling a future chat turn is an agent execution side effect, even though
// the schedule itself is stored in SQLite.  Product/QA deployments therefore
// cannot create/cancel schedules and do not start the dispatcher below.
const scheduledMessageMutationGuard = createMutationCapabilityGuard(
    DEPLOYMENT_CAPABILITIES.AGENT_USE,
);
const settingsWriteGuard = createSettingsAdminRouteGuard('settings', settingsAccessPolicy);
const systemSettingsGuard = createSettingsAdminRouteGuard('system', settingsAccessPolicy);
const userSettingsGuard = createSettingsAdminRouteGuard('user', settingsAccessPolicy);
const pluginSettingsGuard = createSettingsAdminRouteGuard('plugins', settingsAccessPolicy);
const browserSettingsGuard = createSettingsAdminRouteGuard('browser', settingsAccessPolicy);
const providerSettingsGuard = createSettingsAdminRouteGuard('providers', settingsAccessPolicy);
// These routers receive the startup-resolved policy so their inner guards
// cannot re-read mutable process.env or accidentally fall back to a writable
// standalone profile in the 0.78 product/QA deployment.
const assetsRoutes = createAssetsRouter(deploymentCapabilityGuard, {
    deploymentPolicy,
});
const settingsRoutes = createSettingsModule(deploymentPolicy);
const userRoutes = createUserModule(deploymentPolicy);
const voiceRoutes = createVoiceModule(deploymentCapabilityGuard, {
    allowRequestOverrides: !isDeploymentReadOnly(deploymentPolicy),
});
const policyAwareCollaborationRoutes = createCollaborationModule(
    deploymentCapabilityGuard,
    deploymentPolicy,
);
const browserUseRoutes = createBrowserUseRouter({
    capabilityGuard: deploymentCapabilityGuard,
    // BrowserUseService keeps a shared internal `agent` owner. In managed
    // DingTalk mode only a verified settings administrator may inspect that
    // aggregate; local password/developer profiles stay compatible.
    requireManagedSessionListAdmin: managedSsoActorGate,
});
const queryClaude = providerRuntimeService.getRunner('claude');
const queryCursor = providerRuntimeService.getRunner('cursor');
const queryCodex = providerRuntimeService.getRunner('codex');
const queryOpenCode = providerRuntimeService.getRunner('opencode');
const gitRoutes = createGitModule({
    queryClaude,
    queryCursor,
    isProtectedBaselinePath: (projectPath) => sessionWorkspaceService.isProtectedBaselinePath(projectPath),
    capabilityGuard: deploymentCapabilityGuard,
});
const fileTreeRoutes = createFileTreeModule(deploymentCapabilityGuard);
const worktreesRoutes = createWorktreesModule({ deploymentPolicy });
const agentRoutes = createAgentModule({
    queryClaude,
    queryCursor,
    queryCodex,
    queryOpenCode,
    deploymentPolicy,
});

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
createWebSocketServer(server, {
    deploymentPolicy,
    verifyClient: {
        allowUnauthenticatedPlatform: AUTH_DEPLOYMENT_MODE.platformBypass,
        // The allowlist-authenticated DingTalk actor is the access boundary.
        // Project-person mapping is attribution and must not block chat.
        requireDingTalkActor: managedSsoActorGate,
        authenticateWebSocket,
    },
    chat: {
        runtime: providerRuntimeService,
    },
    shell: {
        resolveSessionProjectPath: (sessionId) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            return dbSession?.runtime_path ?? dbSession?.project_path ?? null;
        },
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            // Provider-native ids are scoped to their adapter. Never let a
            // shell opened for one provider resume a row owned by another.
            if (dbSession?.provider === provider) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
    },
    getPluginPort,
});

app.use(cors({ exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION
    });
});

// Public share snapshots intentionally bypass both login and the optional
// installation API key. They are authorized solely by an unguessable,
// expiring bearer token and expose a materialized safe snapshot.
app.use('/api/public/shares', publicShareRoutes);

// Git hooks run in provider child processes and authenticate with a short-lived
// execution token. Keep this loopback-only route ahead of installation API-key
// and browser JWT middleware; the route enforces both boundaries itself. The
// deployment guard is an additional defense-in-depth check: a product/QA
// read-only process has no Git-write capability and must not accept any commit
// receipt, even if a local hook token were presented.
app.use(
    '/api/internal/commit-receipts',
    createInternalCommitReceiptModule(deploymentCapabilityGuard),
);

// The Browser MCP child authenticates with its own installation-local bearer
// token. Mount its callback before the optional API-wide key without weakening
// the dedicated bridge token check.
// The default router is retained for standalone consumers/tests. Production
// receives a policy-aware instance so the MCP token cannot bypass the
// deployment's browser side-effect boundary.
const policyAwareBrowserUseMcpRoutes = createBrowserUseMcpRouter({
    capabilityGuard: deploymentCapabilityGuard,
});

// The legacy Agent route has its own API-key authentication below, but the
// deployment capability must be evaluated before the installation-wide key
// middleware installed by the Browser MCP bridge helper. Otherwise a
// product/QA request without X-API-Key would receive a misleading 401 before
// the intended 403 capability denial. Developer deployments still pass this
// boundary and continue through both existing key checks unchanged.
mountPreApiKeyCapabilityRoute(
    app,
    '/api/agent',
    deploymentCapabilityGuard(DEPLOYMENT_CAPABILITIES.AGENT_USE),
);
mountBrowserUseMcpBridgeBeforeApiKey(app, validateApiKey, policyAwareBrowserUseMcpRoutes);

// `mountBrowserUseMcpBridgeBeforeApiKey` installs the installation-wide
// API-key middleware immediately after the bridge mount. Public share
// snapshots, internal commit receipts, and the Browser MCP bridge deliberately
// mounted above have their own narrower credentials and remain reachable
// without this optional key.

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Attach the immutable startup policy to every API request after public auth
// routes. Downstream feature guards read this context instead of reparsing
// mutable process.env, while authentication and per-user authorization remain
// separate concerns.
app.use('/api', createDeploymentPolicyContextMiddleware(deploymentPolicy));

// Authenticated clients can discover the deployment boundary and adapt their
// controls (for example, hiding commit/push and interactive terminal actions
// in product/QA mode).  This is informational only; every mutation remains
// guarded server-side by the route and websocket capability checks.
app.get('/api/deployment-policy', authenticateToken, (_req, res) => {
    res.json({
        profile: deploymentPolicy.profile,
        capabilities: deploymentPolicy.capabilities,
        capabilityNames: DEPLOYMENT_CAPABILITIES,
        defaultPermissionMode,
    });
});

// Compatibility alias used by older clients during a rolling deployment.
app.get('/api/capabilities', authenticateToken, (_req, res) => {
    res.json({
        profile: deploymentPolicy.profile,
        capabilities: deploymentPolicy.capabilities,
        capabilityNames: DEPLOYMENT_CAPABILITIES,
        defaultPermissionMode,
    });
});

// File Tree API Routes (protected)
mountProtectedApiRoute(app, '/api/file-tree', authenticateToken, fileTreeRoutes);

// Projects API Routes (protected)
mountProtectedApiRoute(app, '/api/projects', authenticateToken, projectModuleRoutes);

// Shared-workspace actor summaries and immutable session action history.
mountProtectedApiRoute(app, '/api/collaboration', authenticateToken, policyAwareCollaborationRoutes);

// Chat attachment upload/serving (global ~/.cloudcli/assets store, protected)
mountProtectedApiRoute(
    app,
    '/api/assets',
    authenticateToken,
    assetsRoutes,
    attachmentUploadGuard,
);

// Git API Routes (protected)
mountProtectedApiRoute(app, '/api/git', authenticateToken, gitRoutes);

// Git worktree management (protected)
mountProtectedApiRoute(app, '/api/worktrees', authenticateToken, worktreesRoutes);

// TaskMaster API Routes (protected)
mountProtectedApiRoute(
    app,
    '/api/taskmaster',
    authenticateToken,
    taskmasterRoutes,
    taskmasterMutationGuard,
);

// Commands API Routes (protected)
mountProtectedApiRoute(app, '/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
mountProtectedApiRoute(
    app,
    '/api/settings',
    authenticateToken,
    settingsRoutes,
    settingsMutationCapabilityGuard,
    settingsWriteGuard,
);

mountProtectedApiRoute(
    app,
    '/api/system',
    authenticateToken,
    systemRoutes,
    systemMutationGuard,
    systemSettingsGuard,
);

mountProtectedApiRoute(
    app,
    '/api/notifications',
    authenticateToken,
    notificationRoutes,
    notificationMutationGuard,
);

// User API Routes (protected)
mountProtectedApiRoute(
    app,
    '/api/user',
    authenticateToken,
    userRoutes,
    userMutationCapabilityGuard,
    userSettingsGuard,
);

// Plugins API Routes (protected)
mountProtectedApiRoute(
    app,
    '/api/plugins',
    authenticateToken,
    createPluginsModule(deploymentPolicy, {
        requireVerifiedDingTalkActor: managedSsoActorGate,
    }),
    pluginSettingsGuard,
);

// Browser API Routes (protected)
mountProtectedApiRoute(
    app,
    '/api/browser-use',
    authenticateToken,
    browserUseRoutes,
    browserMutationGuard,
    browserSettingsGuard,
);

// Unified provider MCP routes (protected)
// Keep the provider router on the same startup-resolved policy as every other
// production module.  The default standalone router is intentionally retained
// for tests/embedders, but must not be used here because it would re-read
// process.env on each request and could drift from the 0.78 read-only boundary.
const providerRoutes = createProviderRouter({ deploymentPolicy });
mountProtectedApiRoute(
    app,
    '/api/providers',
    authenticateToken,
    providerRoutes,
    providerSettingsGuard,
);
const scheduledMessagesRoutes = createScheduledMessagesRouter({ deploymentPolicy });
mountProtectedApiRoute(
    app,
    '/api/scheduled-messages',
    authenticateToken,
    scheduledMessagesRoutes,
    scheduledMessageMutationGuard,
);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

mountProtectedApiRoute(app, '/api/voice', authenticateToken, voiceRoutes);

// Apply privacy headers to the public React viewer before static/fallback
// handling sends index.html.
app.use('/share', publicSharePageHeaders);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Chat uploads live under /api/assets (server/modules/assets), which stores
// images and general files in the global ~/.cloudcli/assets folder.

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    return String(error.code);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', getErrorMessage(error));
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${terminalTextStyles.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${terminalTextStyles.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${terminalTextStyles.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log(`  ${terminalTextStyles.bright('CloudCLI Server - Ready')}`);
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log('');
            console.log(`${terminalTextStyles.info('[INFO]')} Server URL:  ${terminalTextStyles.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${terminalTextStyles.info('[INFO]')} Installed at: ${terminalTextStyles.dim(appInstallPath)}`);
            console.log(`${terminalTextStyles.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            try {
                // Registering Browser MCP rewrites provider configuration.  A
                // product/QA read-only deployment may still have an old
                // enabled flag in its local database, but must not perform
                // that provider-side mutation during startup.
                const browserRegistrationAllowedByPolicy =
                    hasDeploymentCapability(deploymentPolicy, DEPLOYMENT_CAPABILITIES.BROWSER_USE)
                    && hasDeploymentCapability(deploymentPolicy, DEPLOYMENT_CAPABILITIES.MCP_WRITE);
                const browserIdentityReady = !browserRegistrationAllowedByPolicy
                    || managedIdentityReadyForStartup();
                if (browserRegistrationAllowedByPolicy && browserIdentityReady) {
                    const browserMcp = await reconcileBrowserUseMcpRegistrationOnStartup(browserUseService);
                    if (browserMcp.enabled) {
                        console.log(`${terminalTextStyles.info('[INFO]')} Browser MCP provider registration refreshed`);
                    }
                } else if (browserRegistrationAllowedByPolicy && !browserIdentityReady && managedSsoActorGate) {
                    console.log(`${terminalTextStyles.info('[INFO]')} Browser MCP registration skipped until the project identity registry is available`);
                } else {
                    console.log(`${terminalTextStyles.info('[INFO]')} Browser MCP registration skipped by deployment policy`);
                }
            } catch (error) {
                console.error('[Browser] Failed to refresh Browser MCP provider registration:', getErrorMessage(error));
            }

            // Start watching provider session artifacts. Read-only deployments
            // must not synchronize the provider index or register long-lived
            // filesystem watchers. Developer deployments retain the existing
            // initial sync/watcher behavior.
            await initializeSessionsWatcher({
                enabled: !isDeploymentReadOnly(deploymentPolicy),
                createMissingRoots: !isDeploymentReadOnly(deploymentPolicy),
            });
            // Sends anything that came due while the server was not running,
            // then keeps polling.
            if (hasDeploymentCapability(deploymentPolicy, DEPLOYMENT_CAPABILITIES.AGENT_USE)) {
                initializeScheduledMessageDispatcher(providerRuntimeService, deploymentPolicy);
            } else {
                console.log(`${terminalTextStyles.info('[INFO]')} Scheduled message dispatcher disabled by deployment policy`);
            }

            // Start server-side plugin processes only for a deployment that
            // explicitly grants plugin execution. A read-only 0.78 process
            // may still expose the immutable plugin catalog, but must never
            // execute a previously enabled third-party plugin at boot.
            if (canStartEnabledPluginServers(deploymentPolicy) && managedIdentityReadyForStartup()) {
                startEnabledPluginServers(deploymentPolicy).catch(err => {
                    console.error('[Plugins] Error during startup:', err.message);
                });
            } else {
                console.log(`${terminalTextStyles.info('[INFO]')} Plugin server startup disabled by deployment policy`);
            }
        });

        await closeSessionsWatcher();
        closeScheduledMessageDispatcher();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
