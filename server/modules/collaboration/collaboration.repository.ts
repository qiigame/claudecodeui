import { createHash, randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';
import type {
  CollaborationActorSummary,
  DingTalkActorIdentityInput,
  ExecutionActorIdentity,
  PendingIdentityEnrollment,
  SessionActorEvent,
  SessionAttributionSummary,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  identityRegistryService,
  isIdentityRegistryRequired,
} from './identity-registry.service.js';
import type { ResolvedDingTalkIdentity } from './identity-registry.service.js';

type ActorRow = {
  actor_id: number;
  user_id: number;
  display_name: string;
  badge: string;
  provider: string;
  provider_key: string;
  provider_name: string;
  git_email?: string | null;
  external_subject?: string | null;
  subject_scope?: string | null;
  external_provider_key?: string | null;
  person_id?: string | null;
  identity_status?: string | null;
};

type PendingEnrollmentRow = {
  actor_id: number;
  user_id: number;
  display_name: string;
  provider_key: string;
  provider_name: string;
  external_subject: string | null;
  subject_scope: string | null;
  external_provider_key: string | null;
  identity_status: string;
  created_at: string;
  last_login_at: string | null;
};

const normalizeSubjectScope = (value: string | null | undefined): PendingIdentityEnrollment['subjectScope'] =>
  value === 'global' || value === 'provider' ? value : 'unknown';

type SessionAttributionRow = {
  session_id: string;
  last_action: string;
  updated_at: string;
  participant_count: number;
  created_actor_id: number | null;
  created_user_id: number | null;
  created_display_name: string | null;
  created_badge: string | null;
  created_provider: string | null;
  created_provider_key: string | null;
  created_provider_name: string | null;
  created_person_id: string | null;
  created_identity_status: string | null;
  last_actor_id: number;
  last_user_id: number;
  last_display_name: string;
  last_badge: string;
  last_provider: string;
  last_provider_key: string;
  last_provider_name: string;
  last_person_id: string | null;
  last_identity_status: string;
};

type UserRow = {
  id: number;
  username: string;
};

/**
 * The managed SSO composition root can require a registry even when the
 * legacy `CLOUDCLI_IDENTITY_REGISTRY_REQUIRED` switch was omitted.  Keeping
 * the override optional preserves standalone/local callers and tests.
 */
export type ActorWriteOptions = {
  requireRegistry?: boolean;
};

type ExecutionActorOptions = {
  /** Keep Git/commit callers verified by default; read-only chat may opt out. */
  requireVerifiedIdentity?: boolean;
};

const requiresIdentityRegistry = (options: ActorWriteOptions = {}): boolean => {
  // `isIdentityRegistryRequired()` includes the immutable startup pin.  An
  // execution boundary may opt in explicitly (`true`), but it must never be
  // able to weaken a managed process by passing `{ requireRegistry: false }`
  // after the composition root pinned the registry requirement.
  return isIdentityRegistryRequired() || options.requireRegistry === true;
};

const hashSubject = (providerKey: string, externalSubject: string): string =>
  createHash('sha256').update(`${providerKey}\0${externalSubject}`).digest('hex');

const normalizeDisplayName = (value: string): string => {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return normalized || '钉钉用户';
};

const normalizeBadge = (value: string, displayName: string): string => {
  const candidate = value.trim();
  if (candidate && Array.from(candidate).length <= 4 && !/\s/.test(candidate)) {
    return candidate;
  }
  return Array.from(displayName)[0] ?? '?';
};

const normalizeIdentityStatus = (value: string | null | undefined): CollaborationActorSummary['identityStatus'] =>
  value === 'verified' || value === 'configured' || value === 'pending'
    || value === 'ambiguous' || value === 'legacy'
    ? value
    : 'legacy';

const actorSummary = (row: ActorRow): CollaborationActorSummary => ({
  actorId: row.actor_id,
  userId: row.user_id,
  displayName: row.display_name,
  badge: row.badge,
  provider: row.provider,
  providerName: row.provider_name,
  personId: row.person_id ?? null,
  identityStatus: normalizeIdentityStatus(row.identity_status),
});

const attributionSummary = (row: SessionAttributionRow): SessionAttributionSummary => ({
  // A LEFT JOIN has no creator columns for imported sessions first seen on send.
  createdBy: row.created_actor_id === null ? null : actorSummary({
    actor_id: row.created_actor_id,
    user_id: row.created_user_id!,
    display_name: row.created_display_name!,
    badge: row.created_badge!,
    provider: row.created_provider!,
    provider_key: row.created_provider_key!,
    provider_name: row.created_provider_name!,
    person_id: row.created_person_id,
    identity_status: row.created_identity_status,
  }),
  lastActor: actorSummary({
    actor_id: row.last_actor_id,
    user_id: row.last_user_id,
    display_name: row.last_display_name,
    badge: row.last_badge,
    provider: row.last_provider,
    provider_key: row.last_provider_key,
    provider_name: row.last_provider_name,
    person_id: row.last_person_id,
    identity_status: row.last_identity_status,
  }),
  participantCount: row.participant_count,
  lastAction: row.last_action,
  updatedAt: row.updated_at,
});

const selectActorByUserId = (userId: number): ActorRow | undefined =>
  getConnection()
    .prepare(`
      SELECT actor_id, user_id, display_name, badge, provider, provider_key, provider_name, git_email, external_subject, subject_scope, external_provider_key, person_id, identity_status
      FROM collaboration_actors
      WHERE user_id = ?
    `)
    .get(userId) as ActorRow | undefined;

const selectActorById = (actorId: number): ActorRow | undefined =>
  getConnection()
    .prepare(`
      SELECT actor_id, user_id, display_name, badge, provider, provider_key, provider_name, git_email, external_subject, subject_scope, external_provider_key, person_id, identity_status
      FROM collaboration_actors
      WHERE actor_id = ?
    `)
    .get(actorId) as ActorRow | undefined;

function chooseUsername(displayName: string, subjectHash: string): string {
  const db = getConnection();
  const base = normalizeDisplayName(displayName);
  const available = db.prepare('SELECT 1 FROM users WHERE username = ?').get(base) === undefined;
  if (available) {
    return base;
  }

  for (let length = 6; length <= 16; length += 2) {
    const candidate = `${base}-${subjectHash.slice(0, length)}`;
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate) === undefined) {
      return candidate;
    }
  }

  return `${base}-${randomUUID()}`;
}

function ensureLocalActor(userId: number): ActorRow {
  const existing = selectActorByUserId(userId);
  if (existing) {
    return existing;
  }

  const db = getConnection();
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!user) {
    throw new AppError('Authenticated user was not found.', {
      code: 'COLLABORATION_USER_NOT_FOUND',
      statusCode: 401,
    });
  }

  const displayName = normalizeDisplayName(user.username);
  db.prepare(`
    INSERT INTO collaboration_actors (
      user_id, provider, provider_key, provider_name, subject_hash, display_name, badge, last_login_at
    ) VALUES (?, 'local', 'password', 'Local account', ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(userId, hashSubject('password', `user:${userId}`), displayName, normalizeBadge('', displayName));

  return selectActorByUserId(userId) as ActorRow;
}

/**
 * Revalidates a DingTalk actor against the current coordination registry.
 * Auth requests can outlive a registry PR, so a cached `verified` row must not
 * keep settings-admin or write privileges after its binding is suspended.
 */
function refreshActorIdentity(actor: ActorRow): ActorRow {
  const registryRequired = isIdentityRegistryRequired();
  if (actor.provider === 'dingtalk-bridge') {
    try {
      const input = JSON.parse(actor.external_subject || '{}');
      const resolved = identityRegistryService.resolveDingTalkBridgeIdentity(input, { required: true });
      getConnection().prepare(`
        UPDATE collaboration_actors SET person_id = ?, identity_status = ?, display_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE actor_id = ?
      `).run(resolved.personId, resolved.identityStatus, resolved.displayName, actor.actor_id);
      return { ...actor, person_id: resolved.personId, identity_status: resolved.identityStatus, display_name: resolved.displayName };
    } catch {
      return { ...actor, person_id: null, identity_status: 'pending' };
    }
  }
  if (actor.provider !== 'dingtalk') {
    return actor;
  }

  // Capture the optional database fields once. Apart from making the
  // validation below easier to audit, these locals let TypeScript retain the
  // non-null narrowing across the subsequent registry lookup (property access
  // on a mutable row cannot safely be narrowed through an `await`/callback).
  const externalSubject = actor.external_subject;
  const externalProviderKey = actor.external_provider_key;
  const subjectScope = actor.subject_scope;

  // A managed deployment must not trust a legacy/partially populated actor
  // row merely because it happens to carry `person_id=...` and
  // `identity_status=verified`. Such rows predate the stable-subject binding
  // fields and cannot be revalidated against the registry. Downgrade them
  // before settings/admin predicates inspect the summary; local developer
  // deployments keep the historical compatibility path when the registry is
  // optional.
  const missingStableBinding = !externalSubject
    || !externalProviderKey
    || (subjectScope !== 'global' && subjectScope !== 'provider');
  if (registryRequired && missingStableBinding) {
    if (actor.person_id === null && actor.identity_status === 'pending') {
      return actor;
    }
    getConnection().prepare(`
      UPDATE collaboration_actors
      SET person_id = NULL, identity_status = 'pending', updated_at = CURRENT_TIMESTAMP
      WHERE actor_id = ?
    `).run(actor.actor_id);
    return {
      ...actor,
      person_id: null,
      identity_status: 'pending',
    };
  }

  if (!identityRegistryService.isConfigured({ required: registryRequired })
    || missingStableBinding) {
    return actor;
  }

  let resolved: ResolvedDingTalkIdentity | null = null;
  try {
    resolved = identityRegistryService.resolveDingTalkIdentity({
      providerKey: externalProviderKey,
      ...(subjectScope === 'global'
        ? { unionId: externalSubject }
        : { openId: externalSubject }),
      displayName: actor.display_name,
    }, {
      required: registryRequired,
      // Existing post-migration actors may already hold a stable subject even
      // though their protected runtime binding has not been populated yet.
      allowAutomaticEnrollment: true,
    });
  } catch (error) {
    // A managed registry outage must revoke write trust, but it should not
    // turn an otherwise harmless authenticated read into a misleading JWT
    // failure. Downgrade the actor to the same pending state used for an
    // unmatched subject; mutation/execution gates still surface the concrete
    // 503 registry error at their own boundary.
    if (!registryRequired) throw error;
    resolved = null;
  }
  // A configured registry with no matching subject is an explicit identity
  // loss, not a reason to retain a legacy verified row. Downgrade it so an
  // old JWT cannot retain settings-admin or write privileges.
  const personId = resolved?.personId ?? null;
  const displayName = resolved?.personId
    ? normalizeDisplayName(resolved.displayName)
    : actor.display_name;
  const identityStatus = resolved?.identityStatus ?? 'pending';
  if (actor.person_id === personId
    && actor.identity_status === identityStatus
    && actor.display_name === displayName) {
    return actor;
  }

  getConnection().prepare(`
    UPDATE collaboration_actors
    SET display_name = ?, person_id = ?, identity_status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE actor_id = ?
  `).run(displayName, personId, identityStatus, actor.actor_id);
  return {
    ...actor,
    display_name: displayName,
    person_id: personId,
    identity_status: identityStatus,
  };
}

const SESSION_ATTRIBUTION_SELECT = `
  SELECT
    state.session_id,
    state.last_action,
    state.updated_at,
    COUNT(DISTINCT participants.actor_id) AS participant_count,
    created_actor.actor_id AS created_actor_id,
    created_actor.user_id AS created_user_id,
    created_actor.display_name AS created_display_name,
    created_actor.badge AS created_badge,
    created_actor.provider AS created_provider,
    created_actor.provider_key AS created_provider_key,
    created_actor.provider_name AS created_provider_name,
    created_actor.person_id AS created_person_id,
    created_actor.identity_status AS created_identity_status,
    last_actor.actor_id AS last_actor_id,
    last_actor.user_id AS last_user_id,
    last_actor.display_name AS last_display_name,
    last_actor.badge AS last_badge,
    last_actor.provider AS last_provider,
    last_actor.provider_key AS last_provider_key,
    last_actor.provider_name AS last_provider_name,
    last_actor.person_id AS last_person_id,
    last_actor.identity_status AS last_identity_status
  FROM session_actor_state state
  LEFT JOIN collaboration_actors created_actor ON created_actor.actor_id = state.created_by_actor_id
  JOIN collaboration_actors last_actor ON last_actor.actor_id = state.last_actor_id
  LEFT JOIN session_participants participants ON participants.session_id = state.session_id
`;

const readSessionAttribution = (sessionId: string): SessionAttributionSummary | null => {
  const row = getConnection().prepare(`
    ${SESSION_ATTRIBUTION_SELECT}
    WHERE state.session_id = ?
    GROUP BY state.session_id
  `).get(sessionId) as SessionAttributionRow | undefined;
  return row ? attributionSummary(row) : null;
};

/**
 * Persistence used by the Auth, Providers, Projects, WebSocket, and
 * Collaboration modules to keep trusted actor attribution beside shared
 * sessions without changing their visibility.
 */
export const collaborationRepository = {
  upsertDingTalkActor(input: DingTalkActorIdentityInput): {
    user: { id: number; username: string };
    actor: CollaborationActorSummary;
  } {
    const db = getConnection();
    const actorProvider = input.source ?? 'dingtalk';
    const registryAuthoritative = actorProvider === 'dingtalk' && identityRegistryService.isConfigured();
    const registryIdentity = registryAuthoritative
      ? identityRegistryService.resolveDingTalkIdentity({
        providerKey: input.providerKey,
        ...(input.subjectScope === 'global'
          ? { unionId: input.externalSubject }
          : { openId: input.externalSubject }),
        displayName: input.displayName,
      })
      : null;
    // Once the registry is enabled, its subject lookup is authoritative. In
    // particular, a pending/ambiguous lookup must not inherit a person_id
    // supplied by an older caller or a name-keyed credentials file.
    const resolvedPersonId = registryIdentity ? registryIdentity.personId : input.personId ?? null;
    const resolvedIdentityStatus = registryIdentity?.identityStatus ?? input.identityStatus ?? 'legacy';
    const displayName = normalizeDisplayName(registryIdentity?.displayName || input.displayName);
    // The registry is authoritative when enabled. A legacy credentials-file
    // gitEmail must not smuggle a guessed identity into a shared deployment.
    const gitEmail = registryAuthoritative ? null : input.gitEmail ?? null;
    const badge = normalizeBadge(input.badge, displayName);
    const identityProviderKey = input.subjectScope === 'global' ? 'global' : input.providerKey;
    const subjectHash = hashSubject(identityProviderKey, input.externalSubject);
    let existing = db.prepare(`
      SELECT actor_id, user_id, display_name, badge, provider, provider_key, provider_name, git_email, external_subject, subject_scope, external_provider_key, person_id, identity_status
      FROM collaboration_actors
      WHERE provider = ? AND provider_key = ? AND subject_hash = ?
    `).get(actorProvider, identityProviderKey, subjectHash) as ActorRow | undefined;

    if (!existing && input.subjectScope === 'global') {
      const legacySubjectHash = hashSubject(input.providerKey, input.externalSubject);
      existing = db.prepare(`
        SELECT actor_id, user_id, display_name, badge, provider, provider_key, provider_name, git_email, external_subject, subject_scope, external_provider_key, person_id, identity_status
        FROM collaboration_actors
        WHERE provider = ? AND provider_key = ? AND subject_hash = ?
      `).get(actorProvider, input.providerKey, legacySubjectHash) as ActorRow | undefined;
    }

    if (!existing && actorProvider === 'dingtalk' && !registryIdentity && input.personId) {
      // A registry person id is stable across providers. Display names are not
      // identity keys and therefore never participate in actor migration. This
      // legacy-only compatibility path is deliberately disabled when the
      // registry is authoritative so a person's second DingTalk subject gets
      // its own actor row instead of replacing the first subject's audit key.
      const personMatches = db.prepare(`
        SELECT actor_id, user_id, display_name, badge, provider, provider_key, provider_name, git_email, external_subject, subject_scope, external_provider_key, person_id, identity_status
        FROM collaboration_actors
        WHERE provider = ? AND person_id = ?
      `).all(actorProvider, input.personId) as ActorRow[];
      if (personMatches.length === 1) {
        [existing] = personMatches;
      } else if (personMatches.length > 1) {
        throw new AppError('The project identity is bound to multiple CloudCLI actors.', {
          code: 'COLLABORATION_PERSON_AMBIGUOUS',
          statusCode: 409,
        });
      }
    }

    const transaction = db.transaction(() => {
      let userId: number;
      if (existing) {
        userId = existing.user_id;
        db.prepare(`
          UPDATE collaboration_actors
          SET provider_key = ?, provider_name = ?, subject_hash = ?, external_subject = ?, subject_scope = ?, external_provider_key = ?, display_name = ?, badge = ?, git_email = ?, person_id = ?, identity_status = ?, updated_at = CURRENT_TIMESTAMP,
              last_login_at = CURRENT_TIMESTAMP
          WHERE actor_id = ?
        `).run(
          identityProviderKey,
          input.providerName,
          subjectHash,
          input.externalSubject,
          input.subjectScope,
          input.providerKey,
          displayName,
          badge,
          gitEmail,
          // Once the registry is authoritative, an unmatched or ambiguous
          // subject must explicitly clear any old person_id. Otherwise a
          // suspended/reassigned DingTalk subject could retain its previous
          // person's attribution in the actor row.
          registryAuthoritative ? resolvedPersonId : (resolvedPersonId ?? existing.person_id ?? null),
          registryAuthoritative ? resolvedIdentityStatus : (resolvedIdentityStatus ?? existing.identity_status ?? 'legacy'),
          existing.actor_id,
        );
      } else {
        const username = chooseUsername(displayName, subjectHash);
        const userResult = db.prepare(`
          INSERT INTO users (username, password_hash, last_login, has_completed_onboarding)
          VALUES (?, ?, CURRENT_TIMESTAMP, 1)
        `).run(username, `!dingtalk-oauth:${randomUUID()}`);
        userId = Number(userResult.lastInsertRowid);
        db.prepare(`
          INSERT INTO collaboration_actors (
          user_id, provider, provider_key, provider_name, subject_hash, external_subject, subject_scope, external_provider_key, display_name, badge, git_email,
            person_id, identity_status,
            last_login_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(
          userId,
          actorProvider,
          identityProviderKey,
          input.providerName,
          subjectHash,
          input.externalSubject,
          input.subjectScope,
          input.providerKey,
          displayName,
          badge,
          gitEmail,
          resolvedPersonId,
          resolvedIdentityStatus,
        );
      }

      // This SSO mode shares one already-provisioned runtime configuration;
      // per-user provider onboarding would misleadingly ask every teammate to
      // configure the same server again.
      db.prepare(`
        UPDATE users
        SET last_login = CURRENT_TIMESTAMP, has_completed_onboarding = 1
        WHERE id = ?
      `).run(userId);
      const actor = selectActorByUserId(userId);
      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as UserRow;
      if (!actor || !user) {
        throw new Error('DingTalk actor upsert did not produce a user and actor.');
      }
      return { user, actor: actorSummary(actor) };
    });

    return transaction();
  },

  getActorByUserId(userId: number): CollaborationActorSummary | null {
    const actor = selectActorByUserId(userId);
    const currentActor = actor ? refreshActorIdentity(actor) : null;
    return currentActor ? actorSummary(currentActor) : null;
  },

  getActorById(actorId: number): CollaborationActorSummary | null {
    const actor = selectActorById(actorId);
    // Commit-receipt and audit reads may happen after a registry PR revokes a
    // binding. Refresh here as well as on the authenticated-user path so a
    // stale actor cannot be displayed as verified in reports or receipt APIs.
    const currentActor = actor ? refreshActorIdentity(actor) : null;
    return currentActor ? actorSummary(currentActor) : null;
  },

  /**
   * Returns raw stable subjects only for the administrator enrollment flow.
   * Ordinary actor/session APIs continue to expose summaries without this
   * sensitive provider identifier.
   */
  listPendingIdentityEnrollments(): PendingIdentityEnrollment[] {
    const rows = getConnection().prepare(`
      SELECT actor_id, user_id, display_name, provider_key, provider_name,
             external_subject, subject_scope, external_provider_key,
             identity_status, created_at, last_login_at
      FROM collaboration_actors
      WHERE provider = 'dingtalk'
        -- Legacy rows predate the stable-subject registry and are not safe
        -- enrollment candidates. Bootstrap operators may inspect those rows
        -- through the protected database path; the HTTP admin view must not
        -- mix them into the actionable pending queue.
        AND identity_status IN ('configured', 'pending', 'ambiguous')
      ORDER BY COALESCE(last_login_at, created_at) DESC, actor_id DESC
    `).all() as PendingEnrollmentRow[];
    return rows.map((row) => ({
      actorId: row.actor_id,
      userId: row.user_id,
      displayName: row.display_name,
      providerKey: row.external_provider_key || row.provider_key,
      providerName: row.provider_name,
      externalSubject: row.external_subject,
      subjectScope: normalizeSubjectScope(row.subject_scope),
      identityStatus: row.identity_status === 'configured'
        || row.identity_status === 'ambiguous'
        || row.identity_status === 'legacy'
        ? row.identity_status
        : 'pending',
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    }));
  },

  assertActorCanWrite(userId: number, options: ActorWriteOptions = {}): void {
    const actor = ensureLocalActor(userId);
    // A registry file may be present on a developer machine for inspecting
    // the shared coordination data, but that alone must not turn a local
    // password account into a managed DingTalk account.  Local developer
    // sessions keep their historical Git/chat capability; managed SSO
    // boundaries reject local principals in Auth/Agent before this method is
    // reached.  DingTalk actors, on the other hand, are revalidated below
    // whenever a registry is configured.
    const registryRequired = requiresIdentityRegistry(options);
    if (actor.provider === 'dingtalk-bridge') {
      throw new AppError('Bridge actors may only use the protected read-only bridge entry.', {
        code: 'BRIDGE_ACTOR_READ_ONLY',
        statusCode: 403,
      });
    }
    if (actor.provider !== 'dingtalk') {
      if (registryRequired) {
        throw new AppError('A verified DingTalk project identity is required before this operation.', {
          code: 'IDENTITY_ENROLLMENT_REQUIRED',
          statusCode: 403,
        });
      }
      return;
    }

    // A managed DingTalk deployment must not silently downgrade to the
    // legacy name/subject path when its registry file is absent.  The
    // registry service emits a 503 configuration error, which is preferable
    // to granting a mutation on an indeterminate identity boundary.
    if (!identityRegistryService.isConfigured({ required: registryRequired })) {
      return;
    }
    identityRegistryService.assertConfiguration({ required: registryRequired });
    // Re-resolve the actor on every write boundary. A long-lived JWT must not
    // keep write access after its binding is suspended or removed from the
    // coordination registry; re-login is required to refresh the actor state.
    const currentIdentity = actor.provider === 'dingtalk'
      && actor.external_subject
      && actor.external_provider_key
      && (actor.subject_scope === 'global' || actor.subject_scope === 'provider')
      ? identityRegistryService.resolveDingTalkIdentity({
        providerKey: actor.external_provider_key,
        ...(actor.subject_scope === 'global'
          ? { unionId: actor.external_subject }
          : { openId: actor.external_subject }),
        displayName: actor.display_name,
      }, { required: registryRequired })
      : null;
    if (!actor.person_id
      || actor.identity_status !== 'verified'
      || !currentIdentity
      || currentIdentity.personId !== actor.person_id
      || currentIdentity.identityStatus !== 'verified'
      || currentIdentity.externalSubject !== actor.external_subject) {
      throw new AppError('Your project identity is pending registration. Read-only access remains available.', {
        code: 'IDENTITY_ENROLLMENT_REQUIRED',
        statusCode: 403,
      });
    }
  },

  getExecutionActorIdentity(
    userId: number,
    options: ExecutionActorOptions = {},
  ): ExecutionActorIdentity {
    const actor = refreshActorIdentity(ensureLocalActor(userId));
    if (actor.provider === 'dingtalk-bridge') {
      if (options.requireVerifiedIdentity !== false) {
        throw new AppError('Bridge actors are restricted to read-only chat.', {
          code: 'BRIDGE_ACTOR_READ_ONLY', statusCode: 403,
        });
      }
      if (!actor.person_id || actor.identity_status !== 'verified') {
        throw new AppError('Your bridge identity is pending registration.', {
          code: 'IDENTITY_ENROLLMENT_REQUIRED', statusCode: 403,
        });
      }
      return {
        actor: actorSummary(actor), personId: actor.person_id, identityStatus: 'verified',
        gitIdentityId: null, gitIdentityMode: 'unknown', gitName: actor.display_name, gitEmail: null,
      };
    }
    const requireVerifiedIdentity = options.requireVerifiedIdentity !== false;
    if (requireVerifiedIdentity) {
      this.assertActorCanWrite(userId);
    }
    const userGitIdentity = getConnection().prepare(`
      SELECT git_name, git_email
      FROM users
      WHERE id = ?
    `).get(userId) as { git_name: string | null; git_email: string | null } | undefined;
    const configuredName = userGitIdentity?.git_name?.trim();
    const configuredEmail = userGitIdentity?.git_email?.trim();
    const sharedIdentityEnabled = Boolean(
      process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID?.trim()
      || process.env.CLOUDCLI_SHARED_GIT_NAME?.trim()
      || process.env.CLOUDCLI_SHARED_GIT_EMAIL?.trim(),
    );
    const sharedIdentity = sharedIdentityEnabled
      ? identityRegistryService.getSharedGitIdentity({
          requireVerified: requireVerifiedIdentity,
        })
      : null;
    if (sharedIdentityEnabled && !sharedIdentity) {
      throw new AppError('A shared Git identity is configured but not registered.', {
        code: 'SHARED_GIT_IDENTITY_INVALID',
        statusCode: 503,
      });
    }

    // Apply the coordination registry's VCS mapping to DingTalk actors only.
    // A local developer may keep a registry snapshot in the environment for
    // read-only inspection without losing their normal user Git settings.
    const registryEnabled = identityRegistryService.isConfigured() && actor.provider === 'dingtalk';
    const personalIdentity = !sharedIdentity && actor.person_id && registryEnabled
      ? identityRegistryService.getPersonalGitIdentity(actor.person_id)
      : null;
    if (registryEnabled && !sharedIdentity && !personalIdentity) {
      throw new AppError('No personal or shared Git identity is registered for this project person.', {
        code: 'VCS_IDENTITY_NOT_REGISTERED',
        statusCode: 403,
      });
    }

    return {
      actor: actorSummary(actor),
      personId: actor.person_id ?? null,
      identityStatus: normalizeIdentityStatus(actor.identity_status) ?? 'legacy',
      gitIdentityId: sharedIdentity?.id ?? personalIdentity?.id ?? null,
      gitIdentityMode: sharedIdentity ? 'shared' : personalIdentity ? 'personal' : configuredEmail ? 'personal' : 'unknown',
      gitName: sharedIdentity?.name || personalIdentity?.name || configuredName || actor.display_name,
      gitEmail: sharedIdentity?.email || personalIdentity?.email || (registryEnabled ? null : configuredEmail || actor.git_email?.trim() || null),
    };
  },

  recordSessionAction(sessionId: string, userId: number, action: string): SessionAttributionSummary {
    const db = getConnection();
    const transaction = db.transaction(() => {
      const actor = ensureLocalActor(userId);
      // Continuing an imported session proves only the current operator.
      // Only an explicit create event supplies or fills a missing creator.
      db.prepare(`
        INSERT INTO session_actor_state (
          session_id, created_by_actor_id, last_actor_id, last_action, updated_at
        ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) DO UPDATE SET
          created_by_actor_id = COALESCE(session_actor_state.created_by_actor_id, excluded.created_by_actor_id),
          last_actor_id = excluded.last_actor_id,
          last_action = excluded.last_action,
          updated_at = CURRENT_TIMESTAMP
      `).run(sessionId, action === 'create' ? actor.actor_id : null, actor.actor_id, action);
      db.prepare(`
        INSERT INTO session_participants (
          session_id, actor_id, first_seen_at, last_seen_at, action_count
        ) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
        ON CONFLICT(session_id, actor_id) DO UPDATE SET
          last_seen_at = CURRENT_TIMESTAMP,
          action_count = action_count + 1
      `).run(sessionId, actor.actor_id);
      db.prepare(`
        INSERT INTO session_actor_events (session_id, actor_id, action)
        VALUES (?, ?, ?)
      `).run(sessionId, actor.actor_id, action);
    });
    transaction();

    const summary = readSessionAttribution(sessionId);
    if (!summary) {
      throw new Error('Session attribution write could not be read back.');
    }
    return summary;
  },

  getSessionAttribution(sessionId: string): SessionAttributionSummary | null {
    return readSessionAttribution(sessionId);
  },

  getSessionAttributions(sessionIds: readonly string[]): Map<string, SessionAttributionSummary> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const uniqueIds = [...new Set(sessionIds)];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = getConnection().prepare(`
      ${SESSION_ATTRIBUTION_SELECT}
      WHERE state.session_id IN (${placeholders})
      GROUP BY state.session_id
    `).all(...uniqueIds) as SessionAttributionRow[];
    return new Map(rows.map((row) => [row.session_id, attributionSummary(row)]));
  },

  listSessionEvents(sessionId: string, limit: number): SessionActorEvent[] {
    const rows = getConnection().prepare(`
      SELECT
        events.event_id,
        events.session_id,
        events.action,
        events.created_at,
        actors.actor_id,
        actors.user_id,
        actors.display_name,
        actors.badge,
        actors.provider,
        actors.provider_key,
        actors.provider_name
      FROM session_actor_events events
      JOIN collaboration_actors actors ON actors.actor_id = events.actor_id
      WHERE events.session_id = ?
      ORDER BY events.event_id DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<ActorRow & {
      event_id: number;
      session_id: string;
      action: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      action: row.action,
      createdAt: row.created_at,
      actor: actorSummary(row),
    }));
  },
};
