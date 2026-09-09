import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-history-fallback-db-'));

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

test('Codex history resolves an app/native id before the watcher stores jsonl_path', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-history-fallback-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const providerSessionId = 'codex-native-before-watch';
  const appSessionId = 'app-before-watch';
  const transcriptPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '05',
    `rollout-2026-09-05T00-00-00-${providerSessionId}.jsonl`,
  );

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      transcriptPath,
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: providerSessionId, cwd: workspacePath, thread_source: 'user', source: 'cli' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Can history load before the watcher runs?' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Yes, the native id is enough to locate it.' }],
          },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession(appSessionId, 'codex', workspacePath, 'Before watcher');
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);
      assert.equal(
        sessionsDb.getSessionById(appSessionId)?.jsonl_path,
        null,
        'the test must exercise the pre-watcher fallback',
      );

      const provider = new CodexSessionsProvider();
      const byAppId = await provider.fetchHistory(appSessionId);
      assert.deepEqual(byAppId.messages.map((message) => message.content), [
        'Can history load before the watcher runs?',
        'Yes, the native id is enough to locate it.',
      ]);
      assert.ok(byAppId.messages.every((message) => message.sessionId === appSessionId));

      // Legacy links may address the same row by Codex's native id.  The
      // adapter itself canonicalizes that alias even when sessionsService is
      // not in the call path.
      const byNativeId = await provider.fetchHistory(providerSessionId);
      assert.deepEqual(byNativeId.messages.map((message) => message.content), [
        'Can history load before the watcher runs?',
        'Yes, the native id is enough to locate it.',
      ]);
      assert.ok(byNativeId.messages.every((message) => message.sessionId === appSessionId));
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex native-id fallback rejects a sub-agent rollout with the same filename suffix', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-history-subagent-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const providerSessionId = 'codex-subagent-like-id';
  const transcriptPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '05',
    `rollout-2026-09-05T00-00-00-${providerSessionId}.jsonl`,
  );

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: providerSessionId,
          cwd: workspacePath,
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
        },
      })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-subagent-fallback', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-subagent-fallback', providerSessionId);

      const history = await new CodexSessionsProvider().fetchHistory('app-subagent-fallback');
      assert.equal(history.total, 0);
      assert.deepEqual(history.messages, []);
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex history does not reinterpret an app id as a native id before the first run', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-history-empty-app-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const appSessionId = 'app-before-first-run';
  const transcriptPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '05',
    `rollout-2026-09-05T00-00-00-${appSessionId}.jsonl`,
  );

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      transcriptPath,
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: appSessionId, cwd: workspacePath, thread_source: 'user' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'must not be loaded into the empty app session' },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession(appSessionId, 'codex', workspacePath, 'Before first run');

      const history = await new CodexSessionsProvider().fetchHistory(appSessionId);
      assert.deepEqual(history.messages, []);
      assert.equal(history.total, 0);
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex fallback requires a session_meta envelope instead of any payload id', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-history-metadata-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const providerSessionId = 'codex-payload-id-only';
  const transcriptPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '05',
    `rollout-2026-09-05T00-00-00-${providerSessionId}.jsonl`,
  );

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      transcriptPath,
      `${[
        JSON.stringify({
          type: 'event_msg',
          payload: { id: providerSessionId, type: 'user_message', message: 'must not be trusted' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'untrusted' }] },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-metadata-check', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-metadata-check', providerSessionId);

      const history = await new CodexSessionsProvider().fetchHistory('app-metadata-check');
      assert.deepEqual(history.messages, []);
      assert.equal(history.total, 0);
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex history rejects an explicit app/native id mismatch', {
  concurrency: false,
}, async () => {
  await withIsolatedDatabase(async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-history-mismatch-'));
    const workspacePath = path.join(tempDirectory, 'workspace');
    await mkdir(workspacePath, { recursive: true });

    try {
      sessionsDb.createAppSession('app-mismatch', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-mismatch', 'codex-native-a');

      const history = await new CodexSessionsProvider().fetchHistory('app-mismatch', {
        providerSessionId: 'codex-native-b',
      });
      assert.deepEqual(history.messages, []);
      assert.equal(history.total, 0);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

test('Codex history rejects an indexed transcript outside the configured sessions root', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-history-path-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const outsidePath = path.join(tempDirectory, 'outside', 'rollout-outside.jsonl');
  const providerSessionId = 'codex-outside-path';

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(workspacePath, { recursive: true });
    await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
    await mkdir(path.dirname(outsidePath), { recursive: true });
    await writeFile(
      outsidePath,
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: providerSessionId, cwd: workspacePath, thread_source: 'user' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'must not be exposed' },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-outside-path', 'codex', workspacePath);
      // Simulate the watcher having persisted an unsafe path before the
      // reader is called. The reader must still enforce the configured root.
      sessionsDb.createSession(
        providerSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        outsidePath,
      );
      sessionsDb.assignProviderSessionId('app-outside-path', providerSessionId);

      const history = await new CodexSessionsProvider().fetchHistory('app-outside-path');
      assert.deepEqual(history.messages, []);
      assert.equal(history.total, 0);
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex edit anchors reject an indexed transcript outside the configured sessions root', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-edit-anchor-path-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const outsidePath = path.join(tempDirectory, 'outside', 'rollout-edit-outside.jsonl');
  const providerSessionId = 'codex-edit-outside-path';

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(workspacePath, { recursive: true });
    await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
    await mkdir(path.dirname(outsidePath), { recursive: true });
    await writeFile(
      outsidePath,
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: providerSessionId, cwd: workspacePath, thread_source: 'user' },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-outside' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-outside' } }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-edit-outside-path', 'codex', workspacePath);
      sessionsDb.createSession(
        providerSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        outsidePath,
      );
      sessionsDb.assignProviderSessionId('app-edit-outside-path', providerSessionId);

      const anchor = await new CodexSessionsProvider().resolveEditAnchor(
        'app-edit-outside-path',
        'turn-outside',
      );
      assert.deepEqual(anchor, { found: false, resumeThroughId: null });
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex history rejects indexed final symlinks and non-jsonl transcript paths', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-indexed-path-shapes-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const sessionsRoot = path.join(codexHome, 'sessions');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const symlinkSessionId = 'codex-indexed-final-symlink';
  const nonJsonlSessionId = 'codex-indexed-non-jsonl';
  const realTranscriptPath = path.join(sessionsRoot, 'real-transcript.jsonl');
  const symlinkTranscriptPath = path.join(sessionsRoot, 'indexed-symlink.jsonl');
  const nonJsonlTranscriptPath = path.join(sessionsRoot, 'indexed-transcript.txt');

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    const makeTranscript = (providerSessionId: string) => `${[
      JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd: workspacePath, thread_source: 'user' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'must not be exposed' },
      }),
    ].join('\n')}\n`;
    await writeFile(realTranscriptPath, makeTranscript(symlinkSessionId), 'utf8');
    await symlink(realTranscriptPath, symlinkTranscriptPath);
    await writeFile(nonJsonlTranscriptPath, makeTranscript(nonJsonlSessionId), 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-indexed-final-symlink', 'codex', workspacePath);
      sessionsDb.createSession(
        symlinkSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        symlinkTranscriptPath,
      );
      sessionsDb.assignProviderSessionId('app-indexed-final-symlink', symlinkSessionId);

      sessionsDb.createAppSession('app-indexed-non-jsonl', 'codex', workspacePath);
      sessionsDb.createSession(
        nonJsonlSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        nonJsonlTranscriptPath,
      );
      sessionsDb.assignProviderSessionId('app-indexed-non-jsonl', nonJsonlSessionId);

      const provider = new CodexSessionsProvider();
      const symlinkHistory = await provider.fetchHistory('app-indexed-final-symlink');
      const nonJsonlHistory = await provider.fetchHistory('app-indexed-non-jsonl');
      assert.deepEqual(symlinkHistory.messages, []);
      assert.equal(symlinkHistory.total, 0);
      assert.deepEqual(nonJsonlHistory.messages, []);
      assert.equal(nonJsonlHistory.total, 0);
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex history rejects indexed rollouts with invalid metadata or thread kind', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-indexed-metadata-shapes-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const sessionsRoot = path.join(codexHome, 'sessions');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const malformedSessionId = 'codex-indexed-malformed-metadata';
  const wrongIdSessionId = 'codex-indexed-wrong-first-id';
  const wrongKindSessionId = 'codex-indexed-wrong-kind';
  const malformedPath = path.join(sessionsRoot, 'malformed-index.jsonl');
  const wrongIdPath = path.join(sessionsRoot, 'wrong-first-id-index.jsonl');
  const wrongKindPath = path.join(sessionsRoot, 'wrong-kind-index.jsonl');

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      malformedPath,
      `${[
        // A later valid envelope must not make this file trustworthy.
        JSON.stringify({ type: 'session_meta', payload: { cwd: workspacePath } }),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: malformedSessionId, cwd: workspacePath, thread_source: 'user' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'must not be trusted' },
        }),
      ].join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      wrongIdPath,
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'another-codex-thread', cwd: workspacePath, thread_source: 'user' },
        }),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: wrongIdSessionId, cwd: workspacePath, thread_source: 'user' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'wrong first id must not be trusted' },
        }),
      ].join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      wrongKindPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: wrongKindSessionId,
          cwd: workspacePath,
          thread_source: 'subagent',
        },
      })}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-indexed-malformed-metadata', 'codex', workspacePath);
      sessionsDb.createSession(
        malformedSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        malformedPath,
      );
      sessionsDb.assignProviderSessionId('app-indexed-malformed-metadata', malformedSessionId);

      sessionsDb.createAppSession('app-indexed-wrong-first-id', 'codex', workspacePath);
      sessionsDb.createSession(
        wrongIdSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        wrongIdPath,
      );
      sessionsDb.assignProviderSessionId('app-indexed-wrong-first-id', wrongIdSessionId);

      sessionsDb.createAppSession('app-indexed-wrong-kind', 'codex', workspacePath);
      sessionsDb.createSession(
        wrongKindSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        wrongKindPath,
      );
      sessionsDb.assignProviderSessionId('app-indexed-wrong-kind', wrongKindSessionId);

      const provider = new CodexSessionsProvider();
      const malformedHistory = await provider.fetchHistory('app-indexed-malformed-metadata');
      const wrongIdHistory = await provider.fetchHistory('app-indexed-wrong-first-id');
      const wrongKindHistory = await provider.fetchHistory('app-indexed-wrong-kind');
      assert.deepEqual(malformedHistory.messages, []);
      assert.equal(malformedHistory.total, 0);
      assert.deepEqual(wrongIdHistory.messages, []);
      assert.equal(wrongIdHistory.total, 0);
      assert.deepEqual(wrongKindHistory.messages, []);
      assert.equal(wrongKindHistory.total, 0);
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex subagent history rejects final symlink, wrong thread kind, and a later matching envelope', {
  concurrency: false,
}, async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-path-shapes-'));
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const codexHome = path.join(tempDirectory, 'codex-home');
  const sessionsRoot = path.join(codexHome, 'sessions', '2026', '09', '06');
  const workspacePath = path.join(tempDirectory, 'workspace');
  const parentSymlinkId = 'codex-parent-final-symlink';
  const agentSymlinkId = 'codex-agent-final-symlink';
  const parentWrongKindId = 'codex-parent-wrong-kind';
  const agentWrongKindId = 'codex-agent-wrong-kind';
  const parentWrongFirstIdId = 'codex-parent-wrong-first-id';
  const agentWrongFirstIdId = 'codex-agent-wrong-first-id';
  const parentSymlinkPath = path.join(sessionsRoot, `rollout-parent-${parentSymlinkId}.jsonl`);
  const parentWrongKindPath = path.join(sessionsRoot, `rollout-parent-${parentWrongKindId}.jsonl`);
  const parentWrongFirstIdPath = path.join(sessionsRoot, `rollout-parent-${parentWrongFirstIdId}.jsonl`);
  const agentSymlinkTargetPath = path.join(sessionsRoot, 'agent-symlink-target.jsonl');
  const agentSymlinkPath = path.join(sessionsRoot, `rollout-agent-${agentSymlinkId}.jsonl`);
  const agentWrongKindPath = path.join(sessionsRoot, `rollout-agent-${agentWrongKindId}.jsonl`);
  const agentWrongFirstIdPath = path.join(sessionsRoot, `rollout-agent-${agentWrongFirstIdId}.jsonl`);

  const parentTranscript = (parentId: string, agentId: string, agentPath: string) => `${[
    JSON.stringify({
      type: 'session_meta',
      payload: { id: parentId, cwd: workspacePath, thread_source: 'user' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: `spawn-${agentId}`,
        arguments: JSON.stringify({ task_name: agentPath.split('/').pop() }),
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        kind: 'started',
        event_id: `spawn-${agentId}`,
        agent_thread_id: agentId,
        agent_path: agentPath,
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: agentPath,
        content: [{
          type: 'input_text',
          text: `Message Type: FINAL_ANSWER\nSender: ${agentPath}\nPayload:\nDone.`,
        }],
      },
    }),
  ].join('\n')}\n`;

  try {
    process.env.COMIC_CODEX_HOME = codexHome;
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      parentSymlinkPath,
      parentTranscript(parentSymlinkId, agentSymlinkId, '/root/agent-symlink'),
      'utf8',
    );
    await writeFile(
      parentWrongKindPath,
      parentTranscript(parentWrongKindId, agentWrongKindId, '/root/agent-wrong-kind'),
      'utf8',
    );
    await writeFile(
      parentWrongFirstIdPath,
      parentTranscript(parentWrongFirstIdId, agentWrongFirstIdId, '/root/agent-wrong-first-id'),
      'utf8',
    );

    const validSubagentTranscript = `${[
      JSON.stringify({
        type: 'session_meta',
        payload: { id: agentSymlinkId, cwd: workspacePath, thread_source: 'subagent' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'symlink target activity' }],
        },
      }),
    ].join('\n')}\n`;
    await writeFile(agentSymlinkTargetPath, validSubagentTranscript, 'utf8');
    await symlink(agentSymlinkTargetPath, agentSymlinkPath);
    await writeFile(
      agentWrongKindPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: agentWrongKindId, cwd: workspacePath, thread_source: 'user' },
      })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'wrong kind activity' }],
        },
      })}\n`,
      'utf8',
    );
    await writeFile(
      agentWrongFirstIdPath,
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'another-agent-thread', cwd: workspacePath, thread_source: 'subagent' },
        }),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: agentWrongFirstIdId, cwd: workspacePath, thread_source: 'subagent' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'wrong first id activity' }],
          },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-final-symlink', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-final-symlink', parentSymlinkId);
      sessionsDb.createAppSession('app-parent-wrong-kind', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-wrong-kind', parentWrongKindId);
      sessionsDb.createAppSession('app-parent-wrong-first-id', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-wrong-first-id', parentWrongFirstIdId);

      const provider = new CodexSessionsProvider();
      const symlinkHistory = await provider.fetchHistory('app-parent-final-symlink');
      const wrongKindHistory = await provider.fetchHistory('app-parent-wrong-kind');
      const wrongFirstIdHistory = await provider.fetchHistory('app-parent-wrong-first-id');
      const symlinkTask = symlinkHistory.messages.find(
        (message) => message.kind === 'tool_use' && message.toolName === 'Task',
      );
      const wrongKindTask = wrongKindHistory.messages.find(
        (message) => message.kind === 'tool_use' && message.toolName === 'Task',
      );
      const wrongFirstIdTask = wrongFirstIdHistory.messages.find(
        (message) => message.kind === 'tool_use' && message.toolName === 'Task',
      );

      assert.ok(symlinkTask, 'the parent Task row should remain visible');
      assert.ok(wrongKindTask, 'the parent Task row should remain visible');
      assert.ok(wrongFirstIdTask, 'the parent Task row should remain visible');
      assert.equal(symlinkTask?.subagentTools, undefined);
      assert.equal(wrongKindTask?.subagentTools, undefined);
      assert.equal(wrongFirstIdTask?.subagentTools, undefined);
    });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.COMIC_CODEX_HOME;
    } else {
      process.env.COMIC_CODEX_HOME = previousCodexHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
