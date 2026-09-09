import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';

import type {
  CollaborationActorSummary,
  DingTalkActorIdentityInput,
} from '@/shared/types.js';
import type { DeploymentProfile } from '@/modules/deployment-policy/index.js';
import type { ResolvedDingTalkIdentity } from '@/modules/collaboration/index.js';
import { AppError } from '@/shared/utils.js';

import { AUTH_DEPLOYMENT_MODE } from './auth-policy.js';
import { withSettingsPermissions } from './settings-access.middleware.js';

const DEFAULT_AUTH_URL = 'https://login.dingtalk.com/oauth2/auth';
const DEFAULT_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const DEFAULT_USERINFO_URL = 'https://api.dingtalk.com/v1.0/contact/users/me';

/** Used by Auth routes to bind a callback to the browser that began OAuth. */
export const DINGTALK_STATE_COOKIE = 'cloudcli_dingtalk_state';
/** Used by Auth routes for the short-lived HttpOnly JWT handoff after callback. */
export const DINGTALK_SESSION_COOKIE = 'cloudcli_dingtalk_session';

type DingTalkProvider = {
  key: string;
  name: string;
  clientId: string;
  clientSecret: string;
  allowedUsers: string[];
};

type DingTalkIdentityOverride = {
  badge?: string;
  gitEmail?: string;
};

type DingTalkConfiguration = {
  sessionSecret: string;
  providers: DingTalkProvider[];
  allowedUsers: string[];
  globalAllowlistConfigured: boolean;
  identities: Record<string, DingTalkIdentityOverride>;
  publicOrigin: string;
  secureCookies: boolean;
};

type DingTalkUser = {
  openId?: string;
  unionId?: string;
  name: string;
  openIdAliases: string[];
  unionIdAliases: string[];
  nameAliases: string[];
};

type DingTalkOAuthDependencies = {
  credentialsPath?: string;
  publicOrigin?: string;
  allowInsecureHttpForTests: boolean;
  authUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  fetch: typeof fetch;
  now: () => number;
  randomNonce: () => string;
  upsertActor: (input: DingTalkActorIdentityInput) => {
    user: { id: number; username: string };
    actor: CollaborationActorSummary;
  };
  generateToken: (user: { id: number; username: string }) => string;
  settingsAdminUserIds?: string;
  /** Immutable startup profile used to derive the settings capability. */
  deploymentProfile?: DeploymentProfile;
  /** Immutable startup SSO switch used by the session handoff decorator. */
  requiresDingTalk?: boolean;
  resolveRegistryIdentity?: (input: {
    providerKey: string;
    unionId?: string;
    openId?: string;
    displayName: string;
  }, options?: {
    required?: boolean;
    allowAutomaticEnrollment?: boolean;
  }) => ResolvedDingTalkIdentity | null;
};

const MANAGED_DINGTALK_PROFILES = new Set<DeploymentProfile>([
  'platform',
  'production',
  'product-qa-readonly',
]);

type SignedPayload = Record<string, unknown> & { exp: number };

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const signPayload = (payload: SignedPayload, secret: string): string => {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

const verifyPayload = (
  token: string,
  secret: string,
  nowSeconds: number,
): SignedPayload | null => {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    return null;
  }
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedPayload;
    return Number.isFinite(payload.exp) && payload.exp >= nowSeconds ? payload : null;
  } catch {
    return null;
  }
};

const sanitizeReturnTo = (input: unknown): string => {
  const candidate = typeof input === 'string' ? input : '/';
  if (
    !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\r\n\0]/.test(candidate)
    || candidate.length > 2048
  ) {
    return '/';
  }

  try {
    const parsed = new URL(candidate, 'https://cloudcli.invalid');
    return parsed.origin === 'https://cloudcli.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : '/';
  } catch {
    return '/';
  }
};

function readConfiguration(dependencies: DingTalkOAuthDependencies): DingTalkConfiguration {
  if (!dependencies.credentialsPath || !dependencies.publicOrigin) {
    throw new AppError('DingTalk OAuth is not configured.', {
      code: 'DINGTALK_NOT_CONFIGURED',
      statusCode: 503,
    });
  }

  const raw = readCredentialsFile(dependencies.credentialsPath);

  const origin = new URL(dependencies.publicOrigin);
  const isSecure = origin.protocol === 'https:';
  const insecureTestOrigin = origin.protocol === 'http:' && dependencies.allowInsecureHttpForTests;
  if ((!isSecure && !insecureTestOrigin) || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new AppError('DingTalk public origin must be an HTTPS origin.', {
      code: 'DINGTALK_PUBLIC_ORIGIN_INVALID',
      statusCode: 503,
    });
  }

  const hasGlobalAllowlist = Object.prototype.hasOwnProperty.call(raw, 'allowedUsers');
  const rawProviders = Array.isArray(raw.providers)
    ? raw.providers
    : [{
        key: 'default',
        name: '钉钉',
        clientId: raw.clientId,
        clientSecret: raw.clientSecret,
        allowedUsers: raw.allowedUsers,
      }];
  const providers = rawProviders.map((rawProvider, index) => {
    const provider = (rawProvider ?? {}) as Record<string, unknown>;
    const providerLabel = `DingTalk provider ${String(provider.key ?? index + 1)}`;
    return {
      key: String(provider.key ?? '').trim(),
      name: String(provider.name ?? provider.key ?? '').trim(),
      clientId: String(provider.clientId ?? '').trim(),
      clientSecret: String(provider.clientSecret ?? '').trim(),
      allowedUsers: parseAllowlist(provider.allowedUsers, `${providerLabel} allowlist`),
    };
  });
  const allowedUsers = hasGlobalAllowlist
    ? parseAllowlist(raw.allowedUsers, 'The global DingTalk allowlist')
    : [...new Set(providers.flatMap((provider) => provider.allowedUsers))];
  if (providers.length === 0) {
    throw new Error('At least one DingTalk provider is required.');
  }
  for (const provider of providers) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(provider.key)) {
      throw new Error('DingTalk provider key is invalid.');
    }
    if (!provider.name || !provider.clientId || !provider.clientSecret) {
      throw new Error(`DingTalk provider ${provider.key} is incomplete.`);
    }
  }
  if (new Set(providers.map((provider) => provider.key)).size !== providers.length) {
    throw new Error('DingTalk provider keys must be unique.');
  }
  if (!hasGlobalAllowlist && providers.some((provider) => provider.allowedUsers.length === 0)) {
    throw new Error('Each DingTalk provider must declare an allowlist when no global allowlist is configured.');
  }
  if (allowedUsers.length === 0) {
    throw new Error('The global DingTalk allowlist must not be empty.');
  }

  const sessionSecret = String(raw.sessionSecret ?? '');
  if (sessionSecret.length < 32) {
    throw new Error('DingTalk sessionSecret must contain at least 32 characters.');
  }

  const identities = raw.identities && typeof raw.identities === 'object'
    ? raw.identities as Record<string, DingTalkIdentityOverride>
    : {};

  return {
    sessionSecret,
    providers,
    allowedUsers,
    globalAllowlistConfigured: hasGlobalAllowlist,
    identities,
    publicOrigin: origin.origin,
    secureCookies: isSecure,
  };
}

/**
 * Reads the OAuth secret file through one checked file descriptor.
 *
 * The credentials path is controlled by the deployment environment and
 * contains client secrets and the session-signing key.  A path-only
 * `statSync()` followed by `readFileSync(path)` leaves a symlink/replacement
 * window in which a local account could make the process read a different
 * file.  Refuse final-component symlinks, require a private regular file, and
 * compare the descriptor's device/inode with the pre-opened entry before
 * parsing its contents.  The descriptor is also the source of the bytes, so
 * a later pathname replacement cannot change what is parsed.
 */
function readCredentialsFile(file: string): Record<string, unknown> {
  let fileStat: ReturnType<typeof fs.lstatSync>;
  try {
    fileStat = fs.lstatSync(file);
  } catch (error) {
    throw new AppError(
      `DingTalk credentials file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'DINGTALK_CREDENTIAL_PERMISSIONS',
        statusCode: 503,
      },
    );
  }

  if (!fileStat.isFile() || (fileStat.mode & 0o7777) !== 0o600) {
    throw new AppError('DingTalk credentials file must be a regular file with permissions 0600.', {
      code: 'DINGTALK_CREDENTIAL_PERMISSIONS',
      statusCode: 503,
    });
  }

  let fileDescriptor: number | null = null;
  try {
    // O_NOFOLLOW is available on the Unix deployment targets.  The inode /
    // device comparison below remains a second line of defence on platforms
    // that do not expose the flag (and catches a replacement race after
    // lstat, including a regular-file swap).
    const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fileDescriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fileDescriptor);
    if (!openedStat.isFile()
      || (openedStat.mode & 0o7777) !== 0o600
      || openedStat.dev !== fileStat.dev
      || openedStat.ino !== fileStat.ino) {
      throw new Error('the protected credentials file changed while it was being opened');
    }

    const contents = fs.readFileSync(fileDescriptor, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new AppError(
        `DingTalk credentials file contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'DINGTALK_CREDENTIAL_INVALID',
          statusCode: 503,
        },
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('DingTalk credentials file must contain a JSON object.', {
        code: 'DINGTALK_CREDENTIAL_INVALID',
        statusCode: 503,
      });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      `DingTalk credentials file could not be opened safely: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'DINGTALK_CREDENTIAL_PERMISSIONS',
        statusCode: 503,
      },
    );
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  }
}

/**
 * Parses an allowlist at configuration load time. Keeping this validation in
 * the credentials boundary prevents malformed provider entries from degrading
 * into a permissive comparison at request time.
 */
function parseAllowlist(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const entries = [...new Set(value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean))];
  if (entries.some((entry) => !/^(name|openid|unionid):[^\r\n]+$/.test(entry))) {
    throw new Error(`${label} contains an invalid entry.`);
  }
  return entries;
}

const configurationAllowsUser = (
  allowedUsers: string[],
  providerAllowedUsers: string[],
  globalAllowlistConfigured: boolean,
  user: DingTalkUser,
): boolean => {
  const identities = new Set([
    ...user.nameAliases.map((name) => `name:${name}`),
    ...user.openIdAliases.map((openId) => `openid:${openId}`),
    ...user.unionIdAliases.map((unionId) => `unionid:${unionId}`),
  ].filter(Boolean));
  const globalMatch = !globalAllowlistConfigured
    || allowedUsers.some((allowed) => identities.has(allowed));
  // A provider-level list is an additional boundary, never an alternative
  // to the global list. Empty means the operator intentionally relies on the
  // global list for this provider; a non-empty list forms an intersection.
  return globalMatch
    && (providerAllowedUsers.length > 0
      ? providerAllowedUsers.some((allowed) => identities.has(allowed))
      : globalAllowlistConfigured);
};

async function readJsonResponse(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError('DingTalk OAuth upstream is unavailable.', {
      code: 'DINGTALK_UPSTREAM_UNAVAILABLE',
      statusCode: 502,
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new AppError('DingTalk OAuth returned an invalid response.', {
      code: 'DINGTALK_UPSTREAM_INVALID',
      statusCode: 502,
    });
  }
  if (!response.ok) {
    throw new AppError('DingTalk OAuth rejected the request.', {
      code: 'DINGTALK_UPSTREAM_REJECTED',
      statusCode: 502,
    });
  }
  return payload;
}

/**
 * Creates the direct DingTalk OAuth service used by Auth routes and auth status.
 * The service accepts identity only from DingTalk's userinfo response and signs
 * both browser state and the short-lived token handoff with the existing
 * credentials-file session secret.
 */
export function createDingTalkOAuthService(dependencies: DingTalkOAuthDependencies) {
  // `requiresDingTalk` is injected by the normal composition root.  The
  // profile fallback protects alternate/standalone mounts that provide the
  // immutable deployment profile but forgot to copy the separate auth switch.
  // A startup SSO declaration is monotonic: an old explicit `false` cannot
  // reopen the legacy name-only actor path after the process has committed to
  // DingTalk authentication.  Local callers remain compatible when the
  // startup snapshot itself does not require SSO.
  const requiresManagedIdentity = (): boolean => {
    // A managed profile is itself an SSO/registry declaration.  Do not let a
    // legacy adapter pass `requiresDingTalk: false` and reopen the name-only
    // actor path when it supplies `platform`, `production`, or the 0.78
    // read-only profile.  Explicit `false` remains source-compatible only for
    // a genuinely local profile while the immutable startup auth snapshot is
    // also non-SSO.
    const managedProfile = MANAGED_DINGTALK_PROFILES.has(
      dependencies.deploymentProfile as DeploymentProfile,
    );
    return AUTH_DEPLOYMENT_MODE.requiresDingTalk
      || managedProfile
      || dependencies.requiresDingTalk === true;
  };

  return {
    /** Validates a declared SSO configuration for an explicit deployment preflight. */
    assertConfiguration(): void {
      const intended = Boolean(dependencies.credentialsPath || dependencies.publicOrigin);
      if (!intended) {
        return;
      }
      if (!dependencies.credentialsPath || !dependencies.publicOrigin) {
        throw new Error('DingTalk OAuth requires both credentialsPath and publicOrigin.');
      }
      readConfiguration(dependencies);
    },

    getPublicStatus(): { enabled: boolean; providers: Array<{ key: string; name: string }> } {
      if (!dependencies.credentialsPath || !dependencies.publicOrigin) {
        return { enabled: false, providers: [] };
      }
      try {
        const configuration = readConfiguration(dependencies);
        return {
          enabled: true,
          providers: configuration.providers.map(({ key, name }) => ({ key, name })),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[DingTalkOAuth] Configuration is disabled', { error: message });
        return { enabled: false, providers: [] };
      }
    },

    beginLogin(providerKeyInput: unknown, returnToInput: unknown) {
      const configuration = readConfiguration(dependencies);
      const providerKey = typeof providerKeyInput === 'string' ? providerKeyInput.trim() : '';
      const provider = configuration.providers.find((candidate) => candidate.key === providerKey)
        ?? (configuration.providers.length === 1 ? configuration.providers[0] : undefined);
      if (!provider) {
        throw new AppError('DingTalk provider is invalid.', {
          code: 'DINGTALK_PROVIDER_INVALID',
          statusCode: 400,
        });
      }

      const now = dependencies.now();
      const state = signPayload({
        iss: 'cloudcli-dingtalk-state',
        nonce: dependencies.randomNonce(),
        providerKey: provider.key,
        returnTo: sanitizeReturnTo(returnToInput),
        iat: now,
        exp: now + 600,
      }, configuration.sessionSecret);
      const authorizeUrl = new URL(dependencies.authUrl ?? DEFAULT_AUTH_URL);
      authorizeUrl.searchParams.set('redirect_uri', `${configuration.publicOrigin}/api/auth/dingtalk/callback`);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', provider.clientId);
      authorizeUrl.searchParams.set('scope', 'openid');
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('prompt', 'consent');

      return {
        authorizeUrl: authorizeUrl.toString(),
        state,
        secureCookies: configuration.secureCookies,
      };
    },

    async completeLogin(input: { code: unknown; state: unknown; stateCookie: unknown }) {
      const configuration = readConfiguration(dependencies);
      const code = typeof input.code === 'string' ? input.code.trim() : '';
      const state = typeof input.state === 'string' ? input.state : '';
      const stateCookie = typeof input.stateCookie === 'string' ? input.stateCookie : '';
      const statePayload = verifyPayload(state, configuration.sessionSecret, dependencies.now());
      if (
        !code
        || !statePayload
        || statePayload.iss !== 'cloudcli-dingtalk-state'
        || !safeEqual(state, stateCookie)
      ) {
        throw new AppError('DingTalk login state is invalid or expired.', {
          code: 'DINGTALK_STATE_INVALID',
          statusCode: 400,
        });
      }

      const provider = configuration.providers.find(
        (candidate) => candidate.key === statePayload.providerKey,
      );
      if (!provider) {
        throw new AppError('DingTalk provider is no longer configured.', {
          code: 'DINGTALK_PROVIDER_INVALID',
          statusCode: 400,
        });
      }

      const tokenPayload = await readJsonResponse(
        dependencies.fetch,
        dependencies.tokenUrl ?? DEFAULT_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            code,
            grantType: 'authorization_code',
          }),
        },
      );
      const accessToken = typeof tokenPayload.accessToken === 'string' ? tokenPayload.accessToken : '';
      if (!accessToken) {
        throw new AppError('DingTalk token response was incomplete.', {
          code: 'DINGTALK_TOKEN_MISSING',
          statusCode: 502,
        });
      }

      const userPayload = await readJsonResponse(
        dependencies.fetch,
        dependencies.userinfoUrl ?? DEFAULT_USERINFO_URL,
        { headers: { 'x-acs-dingtalk-access-token': accessToken } },
      );
      if (userPayload.visitor === true) {
        throw new AppError('DingTalk visitor accounts are not allowed.', {
          code: 'DINGTALK_VISITOR_DENIED',
          statusCode: 403,
        });
      }
      const stringValues = (...keys: string[]): string[] => [...new Set(keys
        .map((key) => userPayload[key])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean))];
      const openIdAliases = stringValues(
        'openId',
        'openid',
        'openDingTalkId',
        'open_dingtalk_id',
        'userid',
        'userId',
        'user_id',
      );
      const unionIdAliases = stringValues('unionId', 'unionid', 'union_id');
      const nameAliases = stringValues(
        'name',
        'nick',
        'displayName',
        'display_name',
        'englishName',
        'english_name',
      );
      const user: DingTalkUser = {
        openId: openIdAliases[0],
        unionId: unionIdAliases[0],
        name: (nameAliases[0] ?? '钉钉用户').slice(0, 120),
        openIdAliases,
        unionIdAliases,
        nameAliases,
      };
      const externalSubject = user.unionId ?? user.openId;
      if (!externalSubject) {
        throw new AppError('DingTalk user response did not include a stable identifier.', {
          code: 'DINGTALK_USER_ID_MISSING',
          statusCode: 502,
        });
      }
      if (!configurationAllowsUser(
        configuration.allowedUsers,
        provider.allowedUsers,
        configuration.globalAllowlistConfigured,
        user,
      )) {
        throw new AppError('This DingTalk user is not allowed to access CloudCLI.', {
          code: 'DINGTALK_USER_DENIED',
          statusCode: 403,
        });
      }

      // A managed SSO composition must inject the authoritative registry
      // resolver.  Without it, a legacy/custom `upsertActor` adapter could
      // accept a DingTalk subject based only on display name or provider
      // configuration and silently reopen the write path. Standalone local
      // OAuth callers may omit the resolver for backwards compatibility.
      const managedIdentity = requiresManagedIdentity();
      if (managedIdentity && !dependencies.resolveRegistryIdentity) {
        throw new AppError('The project identity registry is unavailable.', {
          code: 'IDENTITY_REGISTRY_NOT_CONFIGURED',
          statusCode: 503,
        });
      }

      const registryIdentity = dependencies.resolveRegistryIdentity?.({
        providerKey: provider.key,
        ...(user.unionId ? { unionId: user.unionId } : {}),
        ...(user.openId ? { openId: user.openId } : {}),
        displayName: user.name,
      }, managedIdentity ? {
        required: true,
        // The allowlist check above authenticates this exact DingTalk login.
        // Its first successful OAuth callback may therefore bind the returned
        // stable subject to one uniquely named active project person.
        allowAutomaticEnrollment: true,
      } : undefined);
      // A managed resolver must return an explicit pending/ambiguous result
      // for an unmatched subject.  Treating `null` as a successful legacy
      // lookup would let a custom upsert adapter fall back to display-name
      // or credentials-file identity data, reopening the write/attribution
      // path while the registry is unavailable.
      if (managedIdentity && !registryIdentity) {
        throw new AppError('The project identity registry is unavailable.', {
          code: 'IDENTITY_REGISTRY_NOT_CONFIGURED',
          statusCode: 503,
        });
      }
      const identityOverride = configuration.identities[user.name] ?? {};
      const resolvedDisplayName = registryIdentity?.personId
        ? registryIdentity.displayName
        : user.name;
      const account = dependencies.upsertActor({
        providerKey: registryIdentity?.providerKey ?? provider.key,
        providerName: provider.name,
        externalSubject: registryIdentity?.externalSubject || externalSubject,
        subjectScope: registryIdentity?.subjectScope ?? (user.unionId ? 'global' : 'provider'),
        displayName: resolvedDisplayName,
        badge: identityOverride.badge ?? Array.from(resolvedDisplayName)[0] ?? '?',
        ...(registryIdentity?.personId ? { personId: registryIdentity.personId } : {}),
        ...(registryIdentity ? { identityStatus: registryIdentity.identityStatus } : {}),
        // A registry VCS mapping is authoritative. The legacy name-keyed
        // override remains only for deployments that have not enabled the
        // registry yet and must never be used to identify the person.
        ...(!managedIdentity && !registryIdentity && identityOverride.gitEmail
          ? { gitEmail: identityOverride.gitEmail }
          : {}),
      });
      const token = dependencies.generateToken(account.user);
      const now = dependencies.now();
      const session = signPayload({
        iss: 'cloudcli-dingtalk-session',
        token,
        user: {
          ...account.user,
          username: account.actor.displayName,
          actor: account.actor,
        },
        actor: account.actor,
        iat: now,
        exp: now + 90,
      }, configuration.sessionSecret);

      return {
        returnTo: sanitizeReturnTo(statePayload.returnTo),
        session,
        secureCookies: configuration.secureCookies,
      };
    },

    consumeSession(sessionInput: unknown) {
      const configuration = readConfiguration(dependencies);
      const session = typeof sessionInput === 'string' ? sessionInput : '';
      const payload = verifyPayload(session, configuration.sessionSecret, dependencies.now());
      if (
        !payload
        || payload.iss !== 'cloudcli-dingtalk-session'
        || typeof payload.token !== 'string'
        || !payload.user
      ) {
        throw new AppError('No completed DingTalk login is available.', {
          code: 'DINGTALK_SESSION_MISSING',
          statusCode: 401,
        });
      }
      const managedIdentity = requiresManagedIdentity();
      const decoratedUser = dependencies.requiresDingTalk === undefined && !managedIdentity
        ? withSettingsPermissions(
          payload.user,
          dependencies.settingsAdminUserIds,
          dependencies.deploymentProfile,
        )
        : withSettingsPermissions(payload.user, {
          configuredUserIds: dependencies.settingsAdminUserIds,
          deploymentProfile: dependencies.deploymentProfile,
          requiresDingTalk: managedIdentity,
        });
      return {
        success: true,
        token: payload.token,
        user: decoratedUser,
        actor: payload.actor ?? null,
      };
    },
  };
}

/** Default cryptographic nonce used by the Auth composition root. */
export const createDingTalkOAuthNonce = (): string => randomBytes(18).toString('base64url');
