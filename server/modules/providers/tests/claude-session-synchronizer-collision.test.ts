import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { buildClaudeProjectDirectoryName } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-session-collision-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

test('Claude synchronizer does not borrow another provider app row on native-id collision', { concurrency: false }, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-session-collision-'));
  const configDirectory = path.join(tempDirectory, 'claude-config');
  const projectPath = path.join(tempDirectory, 'workspace');
  const encodedProjectPath = buildClaudeProjectDirectoryName(projectPath, {
    CLAUDE_CONFIG_DIR: configDirectory,
  });
  assert.ok(encodedProjectPath);
  const projectDirectory = path.join(
    configDirectory,
    'projects',
    encodedProjectPath,
  );
  const sharedId = 'shared-native-id';

  try {
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      path.join(projectDirectory, `${sharedId}.jsonl`),
      `${JSON.stringify({ sessionId: sharedId, cwd: projectPath })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      // The native id is already occupied as another provider's app id. The
      // Claude transcript must wait instead of borrowing or silently losing
      // its row to the provider-guarded SQLite upsert.
      sessionsDb.createAppSession(sharedId, 'codex', projectPath, 'Codex owner');

      const processed = await new ClaudeSessionSynchronizer({
        getClaudeConfigDirectory: () => configDirectory,
      }).synchronize();

      assert.equal(processed, 0);
      assert.equal(sessionsDb.getSessionById(sharedId)?.provider, 'codex');
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
