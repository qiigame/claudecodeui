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
    assert.equal(summary?.createdBy.displayName, '张三');
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
