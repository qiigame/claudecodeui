import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  DeploymentPolicy,
  DeploymentProfile,
} from '@/modules/deployment-policy/index.js';
import type { CollaborationActorSummary } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// Keep standalone settings guards aligned with the immutable auth startup
// snapshot.  A writable `developer` profile can still intentionally run
// behind DingTalk SSO; when an embedder omits the newer `requiresDingTalk`
// option, the profile name alone must not reopen settings/admin access.
import { AUTH_DEPLOYMENT_MODE } from './auth-policy.js';

type SettingsAdminRouteScope =
  | 'browser'
  | 'plugins'
  | 'providers'
  | 'settings'
  | 'system'
  | 'user';

type SettingsPermissionUser = {
  id?: number | string;
  userId?: number | string;
  actor?: Partial<CollaborationActorSummary> | null;
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
};

type SettingsAccessOptions = {
  /** Immutable profile selected by the server composition root. */
  deploymentProfile?: DeploymentProfile;
  /**
   * Whether the startup auth mode requires a DingTalk principal. An explicit
   * `false` is retained for legacy local callers only when the process startup
   * snapshot itself does not require SSO.
   */
  requiresDingTalk?: boolean;
  /** Deployment-owned numeric DingTalk settings-admin allowlist. */
  configuredUserIds?: string;
};

type SettingsAccessPolicyInput =
  | DeploymentProfile
  | Pick<DeploymentPolicy, 'profile'>
  | SettingsAccessOptions;

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MANAGED_SETTINGS_PROFILES = new Set<DeploymentProfile>([
  'platform',
  'production',
  'product-qa-readonly',
]);
const LOCAL_SETTINGS_PROFILES = new Set<DeploymentProfile>([
  'developer',
  'development',
  'self-hosted',
  'test',
]);
// Standalone consumers may omit `configuredUserIds`; capture the deployment
// value once rather than consulting mutable process.env on every request.
// The normal composition root passes its own startup snapshot explicitly.
const DEFAULT_SETTINGS_ADMIN_USER_IDS = process.env.CLOUDCLI_SETTINGS_ADMIN_USER_IDS;

function isKnownDeploymentProfile(value: unknown): value is DeploymentProfile {
  return typeof value === 'string'
    && (MANAGED_SETTINGS_PROFILES.has(value as DeploymentProfile)
      || LOCAL_SETTINGS_PROFILES.has(value as DeploymentProfile));
}

/**
 * Keeps the original `(scope, userIds)` helper call source-compatible while
 * accepting the safer startup-profile-first form used by the composition
 * root. An options/policy object is also accepted for embedders that already
 * carry the immutable deployment policy. Unknown profiles stay managed and
 * therefore fail closed.
 */
type ResolvedSettingsAccessOptions = {
  deploymentProfile: DeploymentProfile;
  requiresDingTalk: boolean;
  configuredUserIds: string | undefined;
};

function resolveSettingsAccessOptions(
  second?: string | SettingsAccessPolicyInput,
  third?: string | DeploymentProfile,
): ResolvedSettingsAccessOptions {
  let deploymentProfile: DeploymentProfile = 'product-qa-readonly';
  let requiresDingTalk = true;
  let configuredUserIds: string | undefined;

  const inferredRequiresDingTalk = (profile: DeploymentProfile): boolean =>
    MANAGED_SETTINGS_PROFILES.has(profile) || AUTH_DEPLOYMENT_MODE.requiresDingTalk;

  if (typeof second === 'object' && second !== null) {
    const options = second as {
      deploymentProfile?: unknown;
      profile?: unknown;
      requiresDingTalk?: unknown;
      configuredUserIds?: unknown;
    };
    if (isKnownDeploymentProfile(options.deploymentProfile)) {
      deploymentProfile = options.deploymentProfile;
    } else if (isKnownDeploymentProfile(options.profile)) {
      deploymentProfile = options.profile;
    }
    if (typeof options.requiresDingTalk === 'boolean') {
      // A composition adapter may pass an old explicit `false`, but it must
      // never weaken the immutable startup SSO decision.  The startup
      // snapshot is process-owned; only when it is false does the explicit
      // legacy override remain meaningful.
      requiresDingTalk = AUTH_DEPLOYMENT_MODE.requiresDingTalk || options.requiresDingTalk;
    } else {
      requiresDingTalk = inferredRequiresDingTalk(deploymentProfile);
    }
    if (typeof options.configuredUserIds === 'string') {
      configuredUserIds = options.configuredUserIds;
    }
  } else if (isKnownDeploymentProfile(second)) {
    // New profile-first form: (profile, userIds).
    deploymentProfile = second;
    requiresDingTalk = inferredRequiresDingTalk(deploymentProfile);
    if (typeof third === 'string' && !isKnownDeploymentProfile(third)) {
      configuredUserIds = third;
    }
  } else {
    // Legacy userIds-first form: (userIds, profile).
    if (typeof second === 'string') {
      configuredUserIds = second;
    }
    if (isKnownDeploymentProfile(third)) {
      deploymentProfile = third;
      requiresDingTalk = inferredRequiresDingTalk(deploymentProfile);
    }
  }

  return {
    deploymentProfile,
    requiresDingTalk,
    configuredUserIds: configuredUserIds ?? DEFAULT_SETTINGS_ADMIN_USER_IDS,
  };
}

function numericUserId(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string'
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Canonicalize an Express router-relative path before applying a route policy.
 * Express route matching is case-insensitive by default and accepts a trailing
 * slash, so policy code must classify the same effective route regardless of
 * spelling. Query strings are ignored because `Request.path` normally omits
 * them, while lightweight callers/tests may pass a full path.
 */
export function normalizeRoutePath(path: string): string {
  const withoutQuery = path.split('?', 1)[0] ?? '';
  if (!withoutQuery || withoutQuery === '/') {
    return '/';
  }
  // Express route matching is case-insensitive by default and accepts
  // repeated/trailing separators. The settings-admin matrix must normalize
  // to the same effective route or `/API-KEYS/` could reach the mutation
  // handler while being misclassified as an ordinary non-admin write.
  return `/${withoutQuery.split('/').filter(Boolean).join('/')}`.toLowerCase();
}

function isWriteMethod(method: string): boolean {
  return !READ_ONLY_METHODS.has(method.toUpperCase());
}

/**
 * Auth middleware and DingTalk OAuth use this parser to interpret the
 * deployment-owned numeric allowlist. Invalid, empty, non-positive, and
 * non-integer entries are ignored so malformed configuration fails closed.
 */
export function parseSettingsAdminUserIds(value: string | undefined): ReadonlySet<number> {
  const userIds = new Set<number>();
  for (const entry of value?.split(',') ?? []) {
    const normalizedEntry = entry.trim();
    const userId = /^[1-9]\d*$/.test(normalizedEntry)
      ? numericUserId(normalizedEntry)
      : null;
    if (userId !== null) {
      userIds.add(userId);
    }
  }
  return userIds;
}

/**
 * Auth responses and management-route authorization use this pure predicate.
 * Managed profiles require a numeric allowlist match plus the matching actor
 * loaded from the trusted DingTalk actor table. Local profiles deliberately
 * retain the authenticated local-account behavior and do not consult that
 * managed-deployment allowlist.
 */
export function canManageSettings(
  userInput: unknown,
  second?: string | SettingsAccessPolicyInput,
  third?: string | DeploymentProfile,
): boolean {
  if (!userInput || typeof userInput !== 'object') {
    return false;
  }

  const user = userInput as SettingsPermissionUser;
  const {
    configuredUserIds,
    deploymentProfile,
    requiresDingTalk,
  } = resolveSettingsAccessOptions(second, third);
  const userId = numericUserId(user.id ?? user.userId);

  // A local developer/self-hosted process is already bounded by the local
  // operator and historically allowed its authenticated account to manage
  // settings. Keep that behavior explicit and scoped to known local profiles;
  // managed/unknown profiles must never inherit this bypass.
  if (LOCAL_SETTINGS_PROFILES.has(deploymentProfile) && !requiresDingTalk) {
    return userId !== null;
  }

  // Deployment profiles are parsed from a closed server-side enum. Treat a
  // future/unknown runtime value as denied until its settings policy is
  // explicitly classified; never turn a typo into a local bypass.
  // A writable `developer` profile may still be explicitly backed by
  // DingTalk SSO. In that hybrid mode the SSO requirement, rather than the
  // profile label, selects the managed identity boundary; keep the same
  // verified-actor + deployment allowlist checks instead of locking the
  // bootstrap administrator out of identity-enrollment management.
  if (!MANAGED_SETTINGS_PROFILES.has(deploymentProfile) && !requiresDingTalk) {
    return false;
  }

  const actorUserId = numericUserId(user.actor?.userId);
  return userId !== null
    && actorUserId === userId
    && user.actor?.provider === 'dingtalk'
    && user.actor?.personId != null
    && user.actor?.identityStatus === 'verified'
    && parseSettingsAdminUserIds(configuredUserIds).has(userId);
}

/**
 * REST auth and DingTalk OAuth handoff responses use this decorator to expose
 * the server-derived capability without replacing any existing user fields.
 */
export function withSettingsPermissions(
  userInput: unknown,
  second?: string | SettingsAccessPolicyInput,
  third?: string | DeploymentProfile,
): SettingsPermissionUser {
  const user = userInput && typeof userInput === 'object'
    ? userInput as SettingsPermissionUser
    : {};
  const {
    configuredUserIds,
    deploymentProfile,
    requiresDingTalk,
  } = resolveSettingsAccessOptions(second, third);
  return {
    ...user,
    permissions: {
      ...user.permissions,
      manageSettings: canManageSettings(user, {
        configuredUserIds,
        deploymentProfile,
        requiresDingTalk,
      }),
    },
  };
}

/**
 * The server composition root uses this pure route matrix to guard only
 * configuration mutations. Read-only plugin assets/RPC, provider sessions,
 * chat, onboarding reads, preferences, and drafts deliberately stay outside.
 */
export function isSettingsAdminRoute(
  scope: SettingsAdminRouteScope,
  methodInput: string,
  pathInput: string,
): boolean {
  const method = methodInput.toUpperCase();
  const path = normalizeRoutePath(pathInput);
  if (!isWriteMethod(method)) {
    return false;
  }

  switch (scope) {
    case 'settings':
      // Keep only the explicitly personal notification preference and Web Push
      // lifecycle endpoints available to ordinary authenticated users. Every
      // other settings mutation (including API keys, credentials, and future
      // endpoints added under this router) fails closed behind the trusted
      // DingTalk-admin allowlist.
      return !((method === 'PUT' && path === '/notification-preferences')
        || (method === 'POST' && (path === '/push/subscribe' || path === '/push/unsubscribe')));
    case 'user':
      return path === '/git-config' && method === 'POST';
    case 'plugins':
      return (method === 'POST' && path === '/install')
        || (method === 'PUT' && /^\/[^/]+\/enable$/.test(path))
        || (method === 'POST' && /^\/[^/]+\/update$/.test(path))
        || (method === 'DELETE' && /^\/[^/]+$/.test(path));
    case 'providers':
      return /^\/[^/]+\/(models|skills|mcp\/servers)(\/[^/]+)?$/.test(path)
        || path === '/mcp/servers/global';
    case 'browser':
      return (method === 'PUT' && path === '/settings')
        || (method === 'POST' && path === '/runtime/install');
    case 'system':
      return method === 'POST' && path === '/update';
  }

  return false;
}

/**
 * The server entrypoint mounts this middleware ahead of each management-capable
 * router. It skips ordinary routes, preserves local-profile settings access,
 * and emits one stable 403 error for managed routes when the trusted
 * DingTalk-admin predicate is not satisfied.
 */
export function createSettingsAdminRouteGuard(
  scope: SettingsAdminRouteScope,
  second?: string | SettingsAccessPolicyInput,
  third?: string | DeploymentProfile,
): RequestHandler {
  const {
    configuredUserIds,
    deploymentProfile,
    requiresDingTalk,
  } = resolveSettingsAccessOptions(second, third);
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (!isSettingsAdminRoute(scope, request.method, request.path)) {
      next();
      return;
    }

    // Local/self-hosted profiles retain the application's historical settings
    // behavior. The DingTalk verified-admin boundary is a managed-deployment
    // concern and must not accidentally lock a developer out of their own
    // provider, plugin, Git, or browser configuration. The profile is injected
    // from the composition root's immutable startup policy rather than read
    // from process.env for every request.
    if (LOCAL_SETTINGS_PROFILES.has(deploymentProfile) && !requiresDingTalk) {
      next();
      return;
    }

    if (!requiresDingTalk && !MANAGED_SETTINGS_PROFILES.has(deploymentProfile)) {
      next(new AppError('Settings management access is denied.', {
        code: 'SETTINGS_ACCESS_DENIED',
        statusCode: 403,
      }));
      return;
    }

    const user = (request as Request & { user?: unknown }).user;
    if (!canManageSettings(user, {
      configuredUserIds,
      deploymentProfile,
      requiresDingTalk,
    })) {
      next(new AppError('Settings management access is denied.', {
        code: 'SETTINGS_ACCESS_DENIED',
        statusCode: 403,
      }));
      return;
    }
    next();
  };
}
