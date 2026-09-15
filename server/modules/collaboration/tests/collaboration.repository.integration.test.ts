import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { collaborationRepository } from '../collaboration.repository.js';

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-collaboration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('shared sessions preserve creator, last actor, participants, and immutable events', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('shared-session', 'codex', '/workspace/comic-app', 'Shared work');
    const alice = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic',
      providerName: '漫剧团队',
      externalSubject: 'alice-union',
      subjectScope: 'global',
      displayName: '张三',
      badge: '张',
    });
    const bob = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic',
      providerName: '漫剧团队',
      externalSubject: 'bob-union',
      subjectScope: 'global',
      displayName: '李四',
      badge: '李',
    });

    collaborationRepository.recordSessionAction('shared-session', alice.user.id, 'create');
    collaborationRepository.recordSessionAction('shared-session', bob.user.id, 'send');

    const summary = collaborationRepository.getSessionAttribution('shared-session');
    assert.equal(summary?.createdBy?.displayName, '张三');
    assert.equal(summary?.lastActor.displayName, '李四');
    assert.equal(summary?.participantCount, 2);
    assert.equal(summary?.lastAction, 'send');

    const batch = collaborationRepository.getSessionAttributions([
      'shared-session',
      'missing-session',
    ]);
    assert.equal(batch.size, 1);
    assert.equal(batch.get('shared-session')?.lastActor.badge, '李');

    const events = collaborationRepository.listSessionEvents('shared-session', 10);
    assert.deepEqual(events.map((event) => [event.action, event.actor.displayName]), [
      ['send', '李四'],
      ['create', '张三'],
    ]);
  });
});

test('the same global DingTalk subject reuses one actor across organizations', async () => {
  await withIsolatedDatabase(() => {
    const first = collaborationRepository.upsertDingTalkActor({
      providerKey: 'haohan',
      providerName: '灏瀚',
      externalSubject: 'shared-union-id',
      subjectScope: 'global',
      displayName: '同一成员',
      badge: '同',
    });
    const second = collaborationRepository.upsertDingTalkActor({
      providerKey: 'dongying',
      providerName: '动影',
      externalSubject: 'shared-union-id',
      subjectScope: 'global',
      displayName: '同一成员',
      badge: '同',
    });

    assert.equal(second.user.id, first.user.id);
    assert.equal(second.actor.actorId, first.actor.actorId);
    assert.equal(second.actor.providerName, '动影');
  });
});

test('pending enrollment keeps the stable subject out of normal actor summaries', async () => {
  await withIsolatedDatabase(() => {
    const account = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic',
      providerName: '漫剧团队',
      externalSubject: 'pending-union',
      subjectScope: 'global',
      displayName: '待登记成员',
      badge: '待',
      identityStatus: 'pending',
    });

    assert.equal(account.actor.personId, null);
    assert.equal(account.actor.identityStatus, 'pending');
    const [enrollment] = collaborationRepository.listPendingIdentityEnrollments();
    assert.equal(enrollment?.actorId, account.actor.actorId);
    assert.equal(enrollment?.userId, account.user.id);
    assert.equal(enrollment?.displayName, '待登记成员');
    assert.equal(enrollment?.providerKey, 'comic');
    assert.equal(enrollment?.providerName, '漫剧团队');
    assert.equal(enrollment?.externalSubject, 'pending-union');
    assert.equal(enrollment?.subjectScope, 'global');
    assert.equal(enrollment?.identityStatus, 'pending');
    assert.equal(typeof enrollment?.createdAt, 'string');
    assert.equal(typeof enrollment?.lastLoginAt, 'string');
    assert.equal('externalSubject' in account.actor, false);
  });
});

test('legacy actors are excluded from the actionable enrollment list', async () => {
  await withIsolatedDatabase(() => {
    collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic',
      providerName: '漫剧团队',
      externalSubject: 'legacy-subject',
      subjectScope: 'global',
      displayName: '历史账号',
      badge: '旧',
      identityStatus: 'legacy',
    });
    assert.deepEqual(collaborationRepository.listPendingIdentityEnrollments(), []);
  });
});

test('bridge actors are isolated from OAuth actors and cannot use write admission', async () => {
  await withIsolatedDatabase(async () => {
    const previousRegistry = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
    const previousMap = process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH;
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-bridge-actor-'));
    const registry = path.join(directory, 'registry.json');
    const runtimeMap = path.join(directory, 'runtime-map.json');
    await writeFile(registry, JSON.stringify({ schema_version: 1, people: [{
      person_id: 'alice', display_name: '桥接成员', status: 'active', vcs_identity_ids: [],
    }], vcs_identities: [] }), { mode: 0o600 });
    await writeFile(runtimeMap, JSON.stringify({ schema_version: 1, dingtalk_subjects: [], dingtalk_senders: [{
      provider_key: 'comic', namespace: 'bridge-app', subject_type: 'open_dingtalk_id',
      subject: 'sender-1', person_id: 'alice', status: 'verified',
    }] }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = registry;
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;
    try {
    const account = collaborationRepository.upsertDingTalkActor({
      source: 'dingtalk-bridge',
      providerKey: 'comic',
      providerName: 'bridge-app',
      externalSubject: JSON.stringify({
        providerKey: 'comic', namespace: 'bridge-app',
        senderScope: 'open_dingtalk_id', senderId: 'sender-1',
      }),
      subjectScope: 'provider',
      displayName: '桥接成员',
      badge: '桥',
      personId: 'alice',
      identityStatus: 'verified',
    });
    assert.equal(account.actor.provider, 'dingtalk-bridge');
    assert.throws(
      () => collaborationRepository.assertActorCanWrite(account.user.id),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BRIDGE_ACTOR_READ_ONLY',
    );
    assert.throws(
      () => collaborationRepository.getExecutionActorIdentity(account.user.id),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BRIDGE_ACTOR_READ_ONLY',
    );
    const identity = collaborationRepository.getExecutionActorIdentity(account.user.id, { requireVerifiedIdentity: false });
    assert.equal(identity.personId, 'alice');
    assert.equal(identity.gitEmail, null);
    assert.equal(identity.gitIdentityMode, 'unknown');
    await writeFile(runtimeMap, JSON.stringify({ schema_version: 1, dingtalk_subjects: [], dingtalk_senders: [] }));
    assert.throws(
      () => collaborationRepository.getExecutionActorIdentity(account.user.id, { requireVerifiedIdentity: false }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'IDENTITY_ENROLLMENT_REQUIRED',
    );
    } finally {
      if (previousRegistry === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
      else process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = previousRegistry;
      if (previousMap === undefined) delete process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH;
      else process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = previousMap;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('actor summaries are downgraded when the registry binding is later suspended', async () => {
  const previousRegistryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
  const previousRegistryRequired = process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
  const previousRuntimeMapPath = process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-collaboration-identity-refresh-'));
  const registryPath = path.join(directory, 'identities.json');
  const runtimeMapPath = path.join(directory, 'identity-runtime-map.json');
  const registry = {
    schema_version: 1,
    people: [{
      person_id: 'alice',
      display_name: '张三',
      status: 'active',
      verification: { status: 'verified' },
      dingtalk: {
        subjects: [{
          provider_key: 'comic',
          binding_ref: 'dingtalk-subject/alice/comic',
          status: 'verified',
        }],
      },
      vcs_identity_ids: [],
    }],
    vcs_identities: [],
  };
  await writeFile(registryPath, JSON.stringify(registry), 'utf8');
  await writeFile(runtimeMapPath, JSON.stringify({
    schema_version: 1,
    dingtalk_subjects: [{
      provider_key: 'comic',
      binding_ref: 'dingtalk-subject/alice/comic',
      subject: 'alice-union',
      subject_scope: 'global',
      status: 'active',
    }],
  }), { mode: 0o600 });
  await chmod(runtimeMapPath, 0o600);
  process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = registryPath;
  process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = '1';
  process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMapPath;

  try {
    await withIsolatedDatabase(async () => {
      const account = collaborationRepository.upsertDingTalkActor({
        providerKey: 'comic',
        providerName: '漫剧团队',
        externalSubject: 'alice-union',
        subjectScope: 'global',
        displayName: '伪造名称',
        badge: '伪',
      });
      assert.equal(account.actor.personId, 'alice');
      assert.equal(account.actor.identityStatus, 'verified');

      const suspended = { ...registry, people: [{
        ...registry.people[0],
        status: 'suspended',
      }] };
      await writeFile(registryPath, JSON.stringify(suspended), 'utf8');
      const refreshed = collaborationRepository.getActorByUserId(account.user.id);
      assert.equal(refreshed?.personId, null);
      assert.equal(refreshed?.identityStatus, 'pending');
    });
  } finally {
    if (previousRegistryPath === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = previousRegistryPath;
    if (previousRegistryRequired === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = previousRegistryRequired;
    if (previousRuntimeMapPath === undefined) delete process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH;
    else process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = previousRuntimeMapPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed actor rows without stable subject fields cannot retain verified settings access', async () => {
  const previousRegistryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
  const previousRegistryRequired = process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-collaboration-identity-legacy-'));
  const registryPath = path.join(directory, 'identities.json');
  await writeFile(registryPath, JSON.stringify({
    schema_version: 1,
    people: [],
    vcs_identities: [],
  }), 'utf8');
  process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = registryPath;
  process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = '1';

  try {
    await withIsolatedDatabase(() => {
      const account = collaborationRepository.upsertDingTalkActor({
        providerKey: 'comic',
        providerName: '漫剧团队',
        externalSubject: 'legacy-union',
        subjectScope: 'global',
        displayName: '旧账号',
        badge: '旧',
        personId: 'legacy-person',
        identityStatus: 'verified',
      });

      // Simulate a row written by a pre-registry release: it still looks
      // verified to a settings predicate but has no stable subject that can
      // be checked against the current registry.
      getConnection().prepare(`
        UPDATE collaboration_actors
        SET external_subject = NULL,
            external_provider_key = NULL,
            subject_scope = NULL,
            person_id = 'legacy-person',
            identity_status = 'verified'
        WHERE actor_id = ?
      `).run(account.actor.actorId);

      const refreshed = collaborationRepository.getActorByUserId(account.user.id);
      assert.equal(refreshed?.personId, null);
      assert.equal(refreshed?.identityStatus, 'pending');
    });
  } finally {
    if (previousRegistryPath === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = previousRegistryPath;
    if (previousRegistryRequired === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = previousRegistryRequired;
    await rm(directory, { recursive: true, force: true });
  }
});

test('first send or retry of imported history leaves creator unknown', async () => {
  await withIsolatedDatabase(() => {
    const alice = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic', providerName: '漫剧团队', externalSubject: 'alice-import',
      subjectScope: 'global', displayName: '张三', badge: '张',
    });
    const bob = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic', providerName: '漫剧团队', externalSubject: 'bob-import',
      subjectScope: 'global', displayName: '李四', badge: '李',
    });
    for (const action of ['send', 'retry']) {
      const sessionId = `imported-${action}`;
      sessionsDb.createAppSession(sessionId, 'codex', '/workspace/comic-app', 'Imported history');
      const first = collaborationRepository.recordSessionAction(sessionId, alice.user.id, action);
      assert.equal(first.createdBy, null);
      assert.equal(first.lastActor.actorId, alice.actor.actorId);
      const continued = collaborationRepository.recordSessionAction(sessionId, bob.user.id, 'send');
      assert.equal(continued.createdBy, null);
      assert.equal(continued.lastActor.actorId, bob.actor.actorId);
      assert.equal(continued.participantCount, 2);
      assert.equal(collaborationRepository.getSessionAttributions([sessionId]).get(sessionId)?.createdBy, null);
      assert.equal(collaborationRepository.listSessionEvents(sessionId, 10).length, 2);
    }
  });
});

test('an explicit create fills an unknown creator and later create events do not overwrite it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('late-create', 'codex', '/workspace/comic-app', 'Late create');
    const alice = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic', providerName: '漫剧团队', externalSubject: 'alice-create',
      subjectScope: 'global', displayName: '张三', badge: '张',
    });
    const bob = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic', providerName: '漫剧团队', externalSubject: 'bob-create',
      subjectScope: 'global', displayName: '李四', badge: '李',
    });
    collaborationRepository.recordSessionAction('late-create', bob.user.id, 'send');
    const created = collaborationRepository.recordSessionAction('late-create', alice.user.id, 'create');
    assert.equal(created.createdBy?.actorId, alice.actor.actorId);
    const repeated = collaborationRepository.recordSessionAction('late-create', bob.user.id, 'create');
    assert.equal(repeated.createdBy?.actorId, alice.actor.actorId);
    assert.equal(repeated.lastActor.actorId, bob.actor.actorId);
  });
});

test('old database migration removes implicit creators but preserves explicit creation and audit history', async () => {
  await withIsolatedDatabase(async () => {
    const alice = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic', providerName: '漫剧团队', externalSubject: 'alice-upgrade',
      subjectScope: 'global', displayName: '张三', badge: '张',
    });
    const bob = collaborationRepository.upsertDingTalkActor({
      providerKey: 'comic', providerName: '漫剧团队', externalSubject: 'bob-upgrade',
      subjectScope: 'global', displayName: '李四', badge: '李',
    });
    for (const sessionId of ['old-import', 'old-created', 'old-no-events']) {
      sessionsDb.createAppSession(sessionId, 'codex', '/workspace/comic-app', sessionId);
    }
    const db = getConnection();
    // Recreate the pre-upgrade table, whose NOT NULL creator was populated on
    // every first action even when the imported session's origin was unknown.
    db.exec(`
      DROP TABLE session_actor_state;
      CREATE TABLE session_actor_state (
        session_id TEXT PRIMARY KEY,
        created_by_actor_id INTEGER NOT NULL,
        last_actor_id INTEGER NOT NULL,
        last_action TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_actor_id) REFERENCES collaboration_actors(actor_id),
        FOREIGN KEY (last_actor_id) REFERENCES collaboration_actors(actor_id)
      )
    `);
    for (const sessionId of ['old-import', 'old-created', 'old-no-events']) {
      db.prepare(`
        INSERT INTO session_actor_state VALUES (?, ?, ?, 'send', '2026-09-01T01:00:00.000Z')
      `).run(sessionId, alice.actor.actorId, bob.actor.actorId);
      db.prepare(`
        INSERT INTO session_participants (session_id, actor_id, action_count) VALUES (?, ?, 2)
      `).run(sessionId, bob.actor.actorId);
    }
    db.prepare("INSERT INTO session_actor_events (session_id, actor_id, action) VALUES ('old-import', ?, 'send')")
      .run(alice.actor.actorId);
    db.prepare("INSERT INTO session_actor_events (session_id, actor_id, action) VALUES ('old-created', ?, 'create')")
      .run(alice.actor.actorId);
    db.prepare("INSERT INTO session_actor_events (session_id, actor_id, action) VALUES ('old-created', ?, 'send')")
      .run(bob.actor.actorId);
    const eventsBefore = db.prepare('SELECT * FROM session_actor_events ORDER BY event_id').all();
    const participantsBefore = db.prepare('SELECT * FROM session_participants ORDER BY session_id').all();

    await initializeDatabase();

    const columns = db.prepare('PRAGMA table_info(session_actor_state)').all() as Array<{ name: string; notnull: number }>;
    assert.equal(columns.find((column) => column.name === 'created_by_actor_id')?.notnull, 0);
    const imported = collaborationRepository.getSessionAttribution('old-import');
    assert.equal(imported?.createdBy, null);
    assert.equal(imported?.lastActor.actorId, bob.actor.actorId);
    assert.equal(imported?.updatedAt, '2026-09-01T01:00:00.000Z');
    assert.equal(collaborationRepository.getSessionAttribution('old-no-events')?.createdBy, null);
    assert.equal(collaborationRepository.getSessionAttribution('old-created')?.createdBy?.actorId, alice.actor.actorId);
    assert.deepEqual(db.prepare('SELECT * FROM session_actor_events ORDER BY event_id').all(), eventsBefore);
    assert.deepEqual(db.prepare('SELECT * FROM session_participants ORDER BY session_id').all(), participantsBefore);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const statesAfter = db.prepare('SELECT * FROM session_actor_state ORDER BY session_id').all();
    await initializeDatabase();
    assert.deepEqual(db.prepare('SELECT * FROM session_actor_state ORDER BY session_id').all(), statesAfter);
    assert.equal(collaborationRepository.recordSessionAction('old-import', bob.user.id, 'retry').createdBy, null);
  });
});
