import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { buildClaudeProjectDirectoryName } from '@/shared/utils.js';

const APP_SESSION_ID = 'app-claude-refresh-1';
const PROVIDER_SESSION_ID = 'provider-claude-refresh-1';

test('Claude history survives refresh before an isolated transcript path is indexed', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousClaudeConfigDirectory = process.env.COMIC_CLAUDE_CONFIG_DIR;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-isolated-refresh-'));
  const databasePath = path.join(tempDirectory, 'cloudcli.db');
  const claudeConfigDirectory = path.join(tempDirectory, 'claude-config');
  const projectPath = path.join(tempDirectory, 'workspace');
  const encodedProjectPath = buildClaudeProjectDirectoryName(projectPath, {
    CLAUDE_CONFIG_DIR: claudeConfigDirectory,
  });
  assert.ok(encodedProjectPath);
  const projectDirectory = path.join(claudeConfigDirectory, 'projects', encodedProjectPath);
  const transcriptPath = path.join(projectDirectory, `${PROVIDER_SESSION_ID}.jsonl`);

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.COMIC_CLAUDE_CONFIG_DIR = claudeConfigDirectory;

  try {
    await Promise.all([
      mkdir(projectDirectory, { recursive: true }),
      mkdir(projectPath, { recursive: true }),
    ]);
    await initializeDatabase();

    const rows = [
      {
        type: 'user',
        uuid: 'user-row-1',
        parentUuid: null,
        sessionId: PROVIDER_SESSION_ID,
        cwd: projectPath,
        timestamp: '2026-09-01T01:00:00.000Z',
        message: { role: 'user', content: 'Does refresh keep this question?' },
      },
      {
        type: 'assistant',
        uuid: 'assistant-row-1',
        parentUuid: 'user-row-1',
        sessionId: PROVIDER_SESSION_ID,
        cwd: projectPath,
        timestamp: '2026-09-01T01:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Yes, it comes from the persisted transcript.' }],
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );

    sessionsDb.createAppSession(APP_SESSION_ID, 'claude', projectPath, 'Refresh regression');
    sessionsDb.assignProviderSessionId(APP_SESSION_ID, PROVIDER_SESSION_ID);
    assert.equal(
      sessionsDb.getSessionById(APP_SESSION_ID)?.jsonl_path,
      null,
      'the refresh must exercise the interval before the watcher backfills jsonl_path',
    );

    const refreshedHistory = await sessionsService.fetchHistory(APP_SESSION_ID, {
      limit: 20,
      offset: 0,
    });

    assert.equal(refreshedHistory.total, 2);
    assert.deepEqual(
      refreshedHistory.messages.map((message) => ({
        role: message.role,
        content: message.content,
        sessionId: message.sessionId,
      })),
      [
        {
          role: 'user',
          content: 'Does refresh keep this question?',
          sessionId: APP_SESSION_ID,
        },
        {
          role: 'assistant',
          content: 'Yes, it comes from the persisted transcript.',
          sessionId: APP_SESSION_ID,
        },
      ],
    );

    // A provider id is runtime-owned rather than HTTP input, but it still
    // cannot be allowed to escape the configured projects directory when the
    // pre-watcher fallback constructs a candidate transcript path.
    const traversalSessionId = 'app-claude-traversal-1';
    const traversalProviderSessionId = '../../outside';
    await writeFile(
      path.join(claudeConfigDirectory, 'outside.jsonl'),
      `${JSON.stringify({
        ...rows[0],
        sessionId: traversalProviderSessionId,
      })}\n`,
      'utf8',
    );
    sessionsDb.createAppSession(traversalSessionId, 'claude', projectPath, 'Traversal guard');
    sessionsDb.assignProviderSessionId(traversalSessionId, traversalProviderSessionId);
    const deniedHistory = await sessionsService.fetchHistory(traversalSessionId);
    assert.equal(deniedHistory.total, 0);

    const synchronizer = new ClaudeSessionSynchronizer({
      getClaudeConfigDirectory: () => claudeConfigDirectory,
    });
    // Simulate scan_state having advanced while the old build watched the
    // wrong ~/.claude root: this transcript predates the cursor but its mapped
    // app row still has to be recovered on the first corrected sync.
    assert.equal(await synchronizer.synchronize(new Date('2999-01-01T00:00:00.000Z')), 1);
    assert.equal(sessionsDb.getSessionById(APP_SESSION_ID)?.jsonl_path, transcriptPath);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousClaudeConfigDirectory === undefined) {
      delete process.env.COMIC_CLAUDE_CONFIG_DIR;
    } else {
      process.env.COMIC_CLAUDE_CONFIG_DIR = previousClaudeConfigDirectory;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
