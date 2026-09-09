import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo', 'Initial CloudCLI message');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
    assert.equal(row?.custom_name, 'Initial CloudCLI message');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});

test('provider-native lookup can disambiguate equal ids across providers', async () => {
  await withIsolatedDatabase(() => {
    // Native ids are opaque and only scoped by provider.  Two adapters may
    // legitimately expose the same value; the scoped lookup must not return
    // whichever row happened to be updated most recently.
    sessionsDb.createAppSession('claude-app-shared-id', 'claude', '/workspace/claude');
    sessionsDb.assignProviderSessionId('claude-app-shared-id', 'shared-native-id');
    sessionsDb.createAppSession('codex-app-shared-id', 'codex', '/workspace/codex');
    sessionsDb.assignProviderSessionId('codex-app-shared-id', 'shared-native-id');

    assert.equal(
      sessionsDb.getSessionByProviderSessionId('shared-native-id', 'claude')?.session_id,
      'claude-app-shared-id',
    );
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('shared-native-id', 'codex')?.session_id,
      'codex-app-shared-id',
    );
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('shared-native-id'),
      null,
      'an unscoped native-id lookup must fail closed when providers collide',
    );
  });
});

test('disk discovery never overwrites another provider app row on an id collision', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('shared-app-id', 'claude', '/workspace/claude', 'Keep Claude row');
    // The Codex native id deliberately equals the existing app id.  The
    // provider-scoped upsert must fail closed instead of changing Claude into
    // a Codex session.
    sessionsDb.createSession('shared-app-id', 'codex', '/workspace/codex', 'Must not replace');

    const row = sessionsDb.getSessionById('shared-app-id');
    assert.equal(row?.provider, 'claude');
    assert.equal(row?.provider_session_id, null);
    assert.equal(row?.custom_name, 'Keep Claude row');
    assert.equal(sessionsDb.getSessionByProviderSessionId('shared-app-id', 'codex'), null);
  });
});

test('repointing a provider session does not delete another provider app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('codex-app', 'codex', '/workspace/codex');
    sessionsDb.createAppSession('shared-native-id', 'claude', '/workspace/claude', 'Keep Claude row');

    sessionsDb.repointSessionToProviderSession('codex-app', {
      providerSessionId: 'shared-native-id',
      jsonlPath: '/codex/shared-native-id.jsonl',
    });

    assert.equal(sessionsDb.getSessionById('shared-native-id')?.provider, 'claude');
    assert.equal(sessionsDb.getSessionById('shared-native-id')?.custom_name, 'Keep Claude row');
    assert.equal(sessionsDb.getSessionById('codex-app')?.provider_session_id, 'shared-native-id');
    assert.equal(sessionsDb.getAllSessions().length, 2);
  });
});

test('forking a provider session does not delete another provider app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('shared-fork-id', 'claude', '/workspace/claude', 'Keep Claude row');

    sessionsDb.createForkedSession({
      sessionId: 'codex-fork-app',
      provider: 'codex',
      projectPath: '/workspace/codex',
      customName: 'Codex fork',
      providerSessionId: 'shared-fork-id',
      jsonlPath: '/codex/shared-fork-id.jsonl',
      forkedFromSessionId: 'codex-source',
      model: null,
      effort: null,
    });

    assert.equal(sessionsDb.getSessionById('shared-fork-id')?.provider, 'claude');
    assert.equal(sessionsDb.getSessionById('shared-fork-id')?.custom_name, 'Keep Claude row');
    assert.equal(sessionsDb.getSessionById('codex-fork-app')?.provider_session_id, 'shared-fork-id');
    assert.equal(sessionsDb.getAllSessions().length, 2);
  });
});
