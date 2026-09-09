import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';

// Each provider synchronizer resolves `os.homedir()` when the registry module is
// first imported, so HOME has to point at an empty fixture home *before* that
// import runs. Otherwise the sync pass walks the developer's real ~/.claude.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-prune-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { sessionSynchronizerService } = await import(
  '@/modules/providers/services/session-synchronizer.service.js'
);

process.on('exit', () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

async function withIsolatedDatabase(runTest: (workspace: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-prune-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
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

const PROJECT_PATH = '/tmp/session-prune-project';
const CLAUDE_PROJECT_ROOT = path.join(fixtureHome, '.claude', 'projects', 'session-prune-project');
const CODEX_SESSIONS_ROOT = path.join(fixtureHome, '.codex', 'sessions');

type OrphanSnapshot = ReturnType<typeof sessionsDb.getSessionsWithTranscriptPath>[number];

function readSessionSnapshot(sessionId: string): OrphanSnapshot {
  const row = getConnection().prepare(`
    SELECT session_id, provider, provider_session_id, project_path,
           runtime_path, jsonl_path, isArchived, updated_at
    FROM sessions
    WHERE session_id = ?
  `).get(sessionId) as OrphanSnapshot | undefined;
  assert.ok(row, `expected session ${sessionId} to exist`);
  return row;
}

test('synchronizeSessions drops indexed sessions whose transcript file was deleted', async () => {
  await withIsolatedDatabase(async () => {
    // The prune guard only considers files below the deployment-owned Claude
    // root. Keep the fixture there so this test exercises a real missing
    // transcript rather than an intentionally untrusted path.
    const transcriptDirectory = CLAUDE_PROJECT_ROOT;
    await mkdir(transcriptDirectory, { recursive: true });

    const livePath = path.join(transcriptDirectory, 'live.jsonl');
    await writeFile(livePath, `${JSON.stringify({
      sessionId: 'live-session',
      cwd: PROJECT_PATH,
    })}\n`);
    const deletedPath = path.join(transcriptDirectory, 'orphan-session.jsonl');

    sessionsDb.createSession('live-session', 'claude', PROJECT_PATH, 'Live', undefined, undefined, livePath);
    sessionsDb.createSession('orphan-session', 'claude', PROJECT_PATH, 'Untitled Claude Session', undefined, undefined, deletedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(result.failures, []);
    assert.equal(result.prunedOrphans, 1);
    assert.equal(sessionsDb.getSessionById('orphan-session'), null);
    assert.ok(sessionsDb.getSessionById('live-session'), 'a session whose transcript still exists must survive');
  });
});

test('synchronizeSessions keeps a missing path whose filename does not belong to the indexed native id', async () => {
  await withIsolatedDatabase(async () => {
    const mismatchedPath = path.join(CLAUDE_PROJECT_ROOT, 'some-other-session.jsonl');
    sessionsDb.createSession(
      'orphan-id-mismatch',
      'claude',
      PROJECT_PATH,
      'Mismatched filename',
      undefined,
      undefined,
      mismatchedPath,
    );

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('orphan-id-mismatch'));
  });
});

test('synchronizeSessions keeps a missing Claude transcript nested below the top-level project directory', async () => {
  await withIsolatedDatabase(async () => {
    const nestedPath = path.join(
      CLAUDE_PROJECT_ROOT,
      'nested-project',
      'nested-session',
      'nested-session.jsonl',
    );
    await mkdir(path.dirname(nestedPath), { recursive: true });

    sessionsDb.createSession(
      'nested-session',
      'claude',
      PROJECT_PATH,
      'Nested transcript',
      undefined,
      undefined,
      nestedPath,
    );

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('nested-session'));
  });
});

test('synchronizeSessions keeps a missing Codex transcript with a non-rollout filename prefix', async () => {
  await withIsolatedDatabase(async () => {
    const providerSessionId = 'codex-garbage-id';
    const garbagePath = path.join(
      CODEX_SESSIONS_ROOT,
      '2026',
      '09',
      '06',
      `garbage-${providerSessionId}.jsonl`,
    );
    await mkdir(path.dirname(garbagePath), { recursive: true });

    sessionsDb.createSession(
      providerSessionId,
      'codex',
      PROJECT_PATH,
      'Garbage filename',
      undefined,
      undefined,
      garbagePath,
    );

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById(providerSessionId));
  });
});

test('synchronizeSessions prunes a missing Codex rollout filename in the date tree', async () => {
  await withIsolatedDatabase(async () => {
    const providerSessionId = 'codex-rollout-id';
    const rolloutPath = path.join(
      CODEX_SESSIONS_ROOT,
      '2026',
      '09',
      '06',
      `rollout-2026-09-06T00-00-00-${providerSessionId}.jsonl`,
    );
    await mkdir(path.dirname(rolloutPath), { recursive: true });

    sessionsDb.createSession(
      providerSessionId,
      'codex',
      PROJECT_PATH,
      'Deleted Codex rollout',
      undefined,
      undefined,
      rolloutPath,
    );

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 1);
    assert.equal(sessionsDb.getSessionById(providerSessionId), null);
  });
});

test('deleteOrphanIfUnchanged uses a compare-and-swap snapshot and cleans superseded mappings transactionally', async () => {
  await withIsolatedDatabase(async () => {
    const sessionId = 'cas-orphan-session';
    const transcriptPath = path.join(CLAUDE_PROJECT_ROOT, `${sessionId}.jsonl`);
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    sessionsDb.createSession(
      sessionId,
      'claude',
      PROJECT_PATH,
      'CAS orphan',
      undefined,
      undefined,
      transcriptPath,
    );
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: 'cas-old-provider-id',
      provider: 'claude',
      sessionId,
      jsonlPath: transcriptPath,
    });

    const snapshot = readSessionSnapshot(sessionId);
    // A watcher/upsert changing any identity/path field invalidates the old
    // snapshot, so the prune must leave both the row and its mapping intact.
    getConnection().prepare(
      'UPDATE sessions SET jsonl_path = ? WHERE session_id = ?',
    ).run(path.join(CLAUDE_PROJECT_ROOT, `${sessionId}-repointed.jsonl`), sessionId);
    assert.equal(sessionsDb.deleteOrphanIfUnchanged(snapshot), false);
    assert.ok(sessionsDb.getSessionById(sessionId));
    assert.equal(sessionsDb.getSupersededTranscriptRecords(sessionId).length, 1);

    // Capture the new row and remove it; the mapping must disappear in the
    // same transaction as the successful row delete.
    const currentSnapshot = readSessionSnapshot(sessionId);
    assert.equal(sessionsDb.deleteOrphanIfUnchanged(currentSnapshot), true);
    assert.equal(sessionsDb.getSessionById(sessionId), null);
    assert.deepEqual(sessionsDb.getSupersededTranscriptRecords(sessionId), []);
  });
});

test('deleteOrphanIfUnchanged never removes archived, runtime-backed, or workspace-associated sessions', async () => {
  await withIsolatedDatabase(async () => {
    const db = getConnection();
    const archivedPath = path.join(CLAUDE_PROJECT_ROOT, 'archived-session.jsonl');
    const runtimePath = path.join(CLAUDE_PROJECT_ROOT, 'runtime-session.jsonl');
    const workspacePath = path.join(CLAUDE_PROJECT_ROOT, 'workspace-session.jsonl');
    await mkdir(CLAUDE_PROJECT_ROOT, { recursive: true });

    sessionsDb.createSession('archived-session', 'claude', PROJECT_PATH, 'Archived', undefined, undefined, archivedPath);
    sessionsDb.updateSessionIsArchived('archived-session', true);

    sessionsDb.createSession('runtime-session', 'claude', PROJECT_PATH, 'Runtime', undefined, undefined, runtimePath);
    db.prepare('UPDATE sessions SET runtime_path = ? WHERE session_id = ?').run('/workspace/runtime-session', 'runtime-session');

    sessionsDb.createSession('workspace-session', 'claude', PROJECT_PATH, 'Workspace', undefined, undefined, workspacePath);
    const sourceProject = projectsDb.getProjectPath(PROJECT_PATH);
    assert.ok(sourceProject);
    const workspaceProject = projectsDb.createSessionWorkspacePath('/workspace/session-workspace', 'Session workspace');
    const userResult = db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    ).run('orphan-prune-workspace-owner', 'hash');
    db.prepare(`
      INSERT INTO session_workspaces (
        session_id, source_project_id, source_project_path,
        workspace_project_id, workspace_path, branch_prefix,
        created_by_user_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      'workspace-session',
      sourceProject.project_id,
      sourceProject.project_path,
      workspaceProject.project_id,
      workspaceProject.project_path,
      'cloudcli/session/workspace-session',
      Number(userResult.lastInsertRowid),
    );

    assert.deepEqual(sessionsDb.getSessionsWithTranscriptPath(), []);

    for (const sessionId of ['archived-session', 'runtime-session', 'workspace-session']) {
      assert.equal(
        sessionsDb.deleteOrphanIfUnchanged(readSessionSnapshot(sessionId)),
        false,
      );
      assert.ok(sessionsDb.getSessionById(sessionId));
    }
  });
});

test('synchronizeSessions keeps sessions whose whole transcript directory is missing', async () => {
  await withIsolatedDatabase(async (workspace) => {
    // Stands in for an unmounted or not-yet-created home: every transcript
    // "looks" deleted, so pruning here would wipe the entire index.
    const unmountedPath = path.join(workspace, 'not-mounted', 'session.jsonl');

    sessionsDb.createSession('unmounted-session', 'claude', PROJECT_PATH, 'Unmounted', undefined, undefined, unmountedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('unmounted-session'));
  });
});

test('synchronizeSessions keeps sessions that have no transcript path yet', async () => {
  await withIsolatedDatabase(async () => {
    // App-created rows (jsonl_path NULL until the first provider write) and
    // OpenCode rows (one shared sqlite file, so jsonl_path stays NULL).
    sessionsDb.createAppSession('pending-app-session', 'claude', PROJECT_PATH, 'Pending');
    sessionsDb.createSession('opencode-session', 'opencode', PROJECT_PATH, 'OpenCode', undefined, undefined, null);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(sessionsDb.getSessionById('pending-app-session'));
    assert.ok(sessionsDb.getSessionById('opencode-session'));
  });
});
