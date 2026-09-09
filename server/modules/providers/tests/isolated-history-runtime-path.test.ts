import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { buildClaudeProjectDirectoryName } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'isolated-history-runtime-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'cloudcli.db');
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

test('sessionsService history fallback uses an isolated Claude runtime cwd', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'isolated-claude-history-'));
  const previousClaudeConfigDirectory = process.env.COMIC_CLAUDE_CONFIG_DIR;
  const configDirectory = path.join(tempDirectory, 'claude-config');
  const sourcePath = path.join(tempDirectory, 'source');
  const runtimePath = path.join(tempDirectory, 'runtime');
  const providerSessionId = 'claude-isolated-runtime-history';
  const appSessionId = 'app-claude-isolated-runtime-history';

  try {
    process.env.COMIC_CLAUDE_CONFIG_DIR = configDirectory;
    await mkdir(sourcePath, { recursive: true });
    await mkdir(runtimePath, { recursive: true });

    const runtimeProjectKey = buildClaudeProjectDirectoryName(runtimePath, {
      CLAUDE_CONFIG_DIR: configDirectory,
    });
    const sourceProjectKey = buildClaudeProjectDirectoryName(sourcePath, {
      CLAUDE_CONFIG_DIR: configDirectory,
    });
    assert.ok(runtimeProjectKey);
    assert.ok(sourceProjectKey);

    const runtimeTranscriptPath = path.join(
      configDirectory,
      'projects',
      runtimeProjectKey,
      `${providerSessionId}.jsonl`,
    );
    const sourceTranscriptPath = path.join(
      configDirectory,
      'projects',
      sourceProjectKey,
      `${providerSessionId}.jsonl`,
    );
    await mkdir(path.dirname(runtimeTranscriptPath), { recursive: true });
    await mkdir(path.dirname(sourceTranscriptPath), { recursive: true });

    const transcript = (cwd: string, content: string) => `${[
      JSON.stringify({
        type: 'user',
        uuid: `${content}-user`,
        parentUuid: null,
        sessionId: providerSessionId,
        cwd,
        timestamp: '2026-09-06T00:00:00.000Z',
        message: { role: 'user', content },
      }),
    ].join('\n')}\n`;
    await writeFile(sourceTranscriptPath, transcript(sourcePath, 'source history'), 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession(appSessionId, 'claude', sourcePath, 'isolated Claude', runtimePath);
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);

      // A same-id transcript in the source checkout must not be accepted as
      // the isolated conversation while the runtime artifact is absent.
      const denied = await sessionsService.fetchHistory(appSessionId);
      assert.deepEqual(denied.messages, []);

      await writeFile(runtimeTranscriptPath, transcript(runtimePath, 'runtime history'), 'utf8');
      const history = await sessionsService.fetchHistory(appSessionId);
      assert.deepEqual(history.messages.map((message) => message.content), ['runtime history']);
    });
  } finally {
    closeConnection();
    if (previousClaudeConfigDirectory === undefined) {
      delete process.env.COMIC_CLAUDE_CONFIG_DIR;
    } else {
      process.env.COMIC_CLAUDE_CONFIG_DIR = previousClaudeConfigDirectory;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('sessionsService history fallback rejects a Codex source cwd for an isolated runtime', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'isolated-codex-history-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const sourcePath = path.join(tempDirectory, 'source');
  const runtimePath = path.join(tempDirectory, 'runtime');
  const providerSessionId = 'codex-isolated-runtime-history';
  const appSessionId = 'app-codex-isolated-runtime-history';
  const sourceTranscriptPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '06',
    `rollout-2026-09-06T00-00-00-${providerSessionId}.jsonl`,
  );
  const runtimeTranscriptPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '07',
    `rollout-2026-09-07T00-00-00-${providerSessionId}.jsonl`,
  );

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(sourcePath, { recursive: true });
    await mkdir(runtimePath, { recursive: true });
    await mkdir(path.dirname(sourceTranscriptPath), { recursive: true });
    await mkdir(path.dirname(runtimeTranscriptPath), { recursive: true });
    await writeFile(
      sourceTranscriptPath,
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: providerSessionId, cwd: sourcePath, thread_source: 'user', source: 'cli' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'must not load source history' },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession(appSessionId, 'codex', sourcePath, 'isolated Codex', runtimePath);
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);

      const history = await sessionsService.fetchHistory(appSessionId);
      assert.deepEqual(history.messages, []);
      assert.equal(history.total, 0);

      // If both namespaces contain the same native id, the fallback must skip
      // the source candidate and continue searching until it authenticates the
      // runtime cwd.
      await writeFile(
        runtimeTranscriptPath,
        `${[
          JSON.stringify({
            type: 'session_meta',
            payload: { id: providerSessionId, cwd: runtimePath, thread_source: 'user', source: 'cli' },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'runtime history is selected' },
          }),
        ].join('\n')}\n`,
        'utf8',
      );
      const runtimeHistory = await sessionsService.fetchHistory(appSessionId);
      assert.deepEqual(
        runtimeHistory.messages.map((message) => message.content),
        ['runtime history is selected'],
      );
    });
  } finally {
    closeConnection();
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
