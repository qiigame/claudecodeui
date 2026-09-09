import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';

async function writeRollout(
  codexHome: string,
  sessionId: string,
  projectPath: string,
): Promise<string> {
  const directory = path.join(codexHome, 'sessions', '2026', '09', '04');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-${sessionId}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: projectPath, thread_source: 'user', source: 'cli' },
    })}\n`,
    'utf8',
  );
  return filePath;
}

test('Codex synchronizer indexes only the configured CODEX_HOME tree', {
  concurrency: false,
}, async () => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloudcli-codex-home-isolation-')));
  const isolatedHome = path.join(tempRoot, 'candidate-codex');
  const unrelatedHome = path.join(tempRoot, 'host-codex');
  const workspacePath = path.join(tempRoot, 'workspace');
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databasePath = path.join(tempRoot, 'auth.db');

  try {
    await mkdir(workspacePath, { recursive: true });
    await writeRollout(isolatedHome, 'isolated-session', workspacePath);
    await writeRollout(unrelatedHome, 'unrelated-session', workspacePath);

    closeConnection();
    process.env.DATABASE_PATH = databasePath;
    await initializeDatabase();

    const synchronizer = new CodexSessionSynchronizer({
      getCodexHomeDirectory: () => isolatedHome,
    });
    assert.equal(await synchronizer.synchronize(), 1);
    assert.ok(sessionsDb.getSessionById('isolated-session'));
    assert.equal(sessionsDb.getSessionById('unrelated-session'), null);
    assert.equal(
      sessionsDb.getSessionById('isolated-session')?.jsonl_path?.startsWith(isolatedHome),
      true,
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
