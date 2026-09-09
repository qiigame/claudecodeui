import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionShareLinksDb } from '@/modules/database/repositories/session-share-links.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-shares-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('share repository resolves active hashes, never needs a raw token, and honors creator revocation', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('owner', 'hash');
    const userId = Number((db.prepare('SELECT id FROM users WHERE username = ?').get('owner') as { id: number }).id);
    projectsDb.createProjectPath('/workspace/repo');
    sessionsDb.createAppSession('session-1', 'codex', '/workspace/repo', 'Session');

    sessionShareLinksDb.replaceForCreatorSession({
      id: 'share-1',
      sessionId: 'session-1',
      tokenHash: 'hashed-token-only',
      snapshotJson: '{"version":1}',
      createdByUserId: userId,
      createdAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-02T00:00:00.000Z',
    });

    assert.equal(sessionShareLinksDb.findActiveByTokenHash('raw-token', '2026-09-01T01:00:00.000Z'), null);
    assert.equal(sessionShareLinksDb.findActiveByTokenHash('hashed-token-only', '2026-09-01T01:00:00.000Z')?.id, 'share-1');
    assert.equal(sessionShareLinksDb.revoke('share-1', userId + 1, '2026-09-01T02:00:00.000Z'), false);
    assert.equal(sessionShareLinksDb.revoke('share-1', userId, '2026-09-01T02:00:00.000Z'), true);
    assert.equal(sessionShareLinksDb.findActiveByTokenHash('hashed-token-only', '2026-09-01T03:00:00.000Z'), null);
  });
});

test('replacing a creator session share invalidates the old token and keeps one manageable row', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('owner', 'hash');
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('teammate', 'hash');
    const userId = Number((db.prepare('SELECT id FROM users WHERE username = ?').get('owner') as { id: number }).id);
    const teammateId = Number((db.prepare('SELECT id FROM users WHERE username = ?').get('teammate') as { id: number }).id);
    projectsDb.createProjectPath('/workspace/repo');
    sessionsDb.createAppSession('session-1', 'codex', '/workspace/repo', 'Session');

    sessionShareLinksDb.replaceForCreatorSession({
      id: 'share-1',
      sessionId: 'session-1',
      tokenHash: 'old-token-hash',
      snapshotJson: '{"version":1,"title":"old"}',
      createdByUserId: userId,
      createdAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-02T00:00:00.000Z',
    });
    sessionShareLinksDb.replaceForCreatorSession({
      id: 'share-2',
      sessionId: 'session-1',
      tokenHash: 'new-token-hash',
      snapshotJson: '{"version":1,"title":"new"}',
      createdByUserId: userId,
      createdAt: '2026-09-01T01:00:00.000Z',
      expiresAt: '2026-09-03T00:00:00.000Z',
    });
    sessionShareLinksDb.replaceForCreatorSession({
      id: 'share-teammate',
      sessionId: 'session-1',
      tokenHash: 'teammate-token-hash',
      snapshotJson: '{"version":1,"title":"teammate"}',
      createdByUserId: teammateId,
      createdAt: '2026-09-01T01:30:00.000Z',
      expiresAt: '2026-09-03T00:00:00.000Z',
    });

    assert.equal(sessionShareLinksDb.findActiveByTokenHash('old-token-hash', '2026-09-01T02:00:00.000Z'), null);
    assert.equal(sessionShareLinksDb.findActiveByTokenHash('new-token-hash', '2026-09-01T02:00:00.000Z')?.id, 'share-2');
    assert.deepEqual(
      sessionShareLinksDb.findActiveBySessionAndCreator('session-1', userId, '2026-09-01T02:00:00.000Z'),
      {
        id: 'share-2',
        session_id: 'session-1',
        created_by_user_id: userId,
        created_at: '2026-09-01T01:00:00.000Z',
        expires_at: '2026-09-03T00:00:00.000Z',
      },
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS count
        FROM session_share_links
        WHERE session_id = ? AND created_by_user_id = ?
      `).get('session-1', userId) as { count: number }).count,
      1,
    );
    assert.equal(
      sessionShareLinksDb.findActiveBySessionAndCreator(
        'session-1',
        teammateId,
        '2026-09-01T02:00:00.000Z',
      )?.id,
      'share-teammate',
    );
  });
});

test('migration collapses legacy duplicates before enforcing creator-session uniqueness', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('owner', 'hash');
    const userId = Number((db.prepare('SELECT id FROM users WHERE username = ?').get('owner') as { id: number }).id);
    projectsDb.createProjectPath('/workspace/repo');
    sessionsDb.createAppSession('session-1', 'codex', '/workspace/repo', 'Session');
    db.exec('DROP INDEX uq_session_share_links_creator_session');
    const insert = db.prepare(`
      INSERT INTO session_share_links (
        id, session_id, token_hash, snapshot_json, created_by_user_id, created_at, expires_at
      ) VALUES (?, 'session-1', ?, '{"version":1}', ?, ?, '2026-09-03T00:00:00.000Z')
    `);
    insert.run('share-old', 'old-token-hash', userId, '2026-09-01T00:00:00.000Z');
    insert.run('share-new', 'new-token-hash', userId, '2026-09-01T01:00:00.000Z');
    insert.run('share-revoked', 'revoked-token-hash', userId, '2026-09-01T02:00:00.000Z');
    db.prepare('UPDATE session_share_links SET revoked_at = ? WHERE id = ?').run(
      '2026-09-01T02:30:00.000Z',
      'share-revoked',
    );

    await initializeDatabase();

    const rows = db.prepare(`
      SELECT id FROM session_share_links
      WHERE session_id = 'session-1' AND created_by_user_id = ?
    `).all(userId) as Array<{ id: string }>;
    assert.deepEqual(rows, [{ id: 'share-new' }]);
    assert.throws(() => insert.run(
      'share-third',
      'third-token-hash',
      userId,
      '2026-09-01T02:00:00.000Z',
    ), /UNIQUE constraint failed/);
  });
});
