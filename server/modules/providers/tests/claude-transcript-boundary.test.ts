import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { buildClaudeProjectDirectoryName } from '@/shared/utils.js';

test('Claude history only reads an indexed transcript below the configured projects root', {
  concurrency: false,
}, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousClaudeConfigDirectory = process.env.COMIC_CLAUDE_CONFIG_DIR;
  const tempDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'claude-transcript-boundary-')));
  const databasePath = path.join(tempDirectory, 'cloudcli.db');
  const configDirectory = path.join(tempDirectory, 'claude-config');
  const projectPath = path.join(tempDirectory, 'workspace');
  const encodedProjectPath = buildClaudeProjectDirectoryName(projectPath, {
    CLAUDE_CONFIG_DIR: configDirectory,
  });
  assert.ok(encodedProjectPath);
  const projectDirectory = path.join(configDirectory, 'projects', encodedProjectPath);
  const providerSessionId = 'claude-boundary-session';
  const validTranscriptPath = path.join(projectDirectory, `${providerSessionId}.jsonl`);
  const outsideTranscriptPath = path.join(tempDirectory, `${providerSessionId}-outside.jsonl`);

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.COMIC_CLAUDE_CONFIG_DIR = configDirectory;

  try {
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    const transcript = `${JSON.stringify({
      sessionId: providerSessionId,
      cwd: projectPath,
      type: 'user',
      uuid: 'boundary-user',
      message: { role: 'user', content: 'read only this transcript' },
    })}\n`;
    await writeFile(validTranscriptPath, transcript, 'utf8');
    await writeFile(outsideTranscriptPath, `${JSON.stringify({
      sessionId: 'escaped-session',
      cwd: projectPath,
      type: 'user',
      uuid: 'escaped-user',
      message: { role: 'user', content: 'secret outside transcript' },
    })}\n`, 'utf8');
    await initializeDatabase();

    sessionsDb.createSession(
      providerSessionId,
      'claude',
      projectPath,
      'Valid transcript',
      undefined,
      undefined,
      validTranscriptPath,
    );
    sessionsDb.createSession(
      'escaped-session',
      'claude',
      projectPath,
      'Escaped transcript',
      undefined,
      undefined,
      outsideTranscriptPath,
    );

    const provider = new ClaudeSessionsProvider();
    const valid = await provider.fetchHistory(providerSessionId, {
      providerSessionId,
    });
    const escaped = await provider.fetchHistory('escaped-session', {
      providerSessionId: 'escaped-session',
    });

    assert.equal(valid.total, 1);
    assert.equal(escaped.total, 0);
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
