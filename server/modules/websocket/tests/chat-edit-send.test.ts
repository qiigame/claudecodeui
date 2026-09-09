import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { buildClaudeTranscriptFilePath } from '@/shared/utils.js';

const SESSION_ID = 'edit-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/** Two turns and an edit of the second, which is the transcript the gateway reads. */
const TRANSCRIPT_ROWS = [
  {
    type: 'user', uuid: 'e-u1', parentUuid: null, sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
  },
  {
    type: 'assistant', uuid: 'e-a1', parentUuid: 'e-u1', sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:01.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'reply' }] },
  },
  {
    type: 'user', uuid: 'e-u2', parentUuid: 'e-a1', sessionId: SESSION_ID,
    timestamp: '2026-08-23T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
  },
];

/**
 * The same two turns as a Codex rollout. Codex rows carry no id of their own,
 * so the edit anchor is the enclosing turn — which is also the unit its fork
 * endpoint cuts at.
 */
const CODEX_TRANSCRIPT_ROWS = [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } },
];

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

/**
 * Set by a test that needs a run to still be in flight when the next frame
 * arrives; the stub runtime returns immediately otherwise. Released when the
 * test ends, so no stub run is left pending for the rest of the file.
 */
let holdRun: Promise<void> | null = null;
let releaseHeldRun: (() => void) | null = null;

function holdTheNextRun(): void {
  holdRun = new Promise<void>((resolve) => { releaseHeldRun = resolve; });
}

async function withGateway(
  provider: string,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: RunCall[];
  }) => Promise<void>,
  rows: unknown[] = TRANSCRIPT_ROWS,
  identityOptions: {
    requestUser?: Record<string, unknown>;
    requireDingTalkActor?: boolean;
    requireVerifiedDingTalkActor?: boolean;
    isActorVerified?: (userId: string | number) => boolean;
  } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousClaudeConfig = process.env.COMIC_CLAUDE_CONFIG_DIR;
  const previousCodexHome = process.env.COMIC_CODEX_HOME;
  const tempDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chat-edit-send-')));
  process.env.COMIC_CLAUDE_CONFIG_DIR = path.join(tempDirectory, '.claude');
  process.env.COMIC_CODEX_HOME = path.join(tempDirectory, '.codex');
  const transcriptPath = provider === 'claude'
    ? buildClaudeTranscriptFilePath(process.env.COMIC_CLAUDE_CONFIG_DIR, tempDirectory, SESSION_ID)!
    : path.join(process.env.COMIC_CODEX_HOME, 'sessions', `${SESSION_ID}.jsonl`);
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  // Exercise the production transcript boundary, including its native opening
  // envelope, configured provider root, and effective working directory.
  const authenticatedRows = provider === 'codex'
    ? [{ type: 'session_meta', payload: { id: SESSION_ID, cwd: tempDirectory } }, ...rows]
    : rows.map((row) => ({ ...(row as Record<string, unknown>), cwd: tempDirectory }));
  await writeFile(transcriptPath, `${authenticatedRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  userDb.createUser('chat-edit-test-user', 'not-used');

  const runs: RunCall[] = [];
  const socket = createFakeSocket();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, provider, tempDirectory, 'Edit session', now, now, transcriptPath);

    handleChatConnection(
      socket as never,
      { user: identityOptions.requestUser ?? { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (runProvider: string, command: string, options: Record<string, unknown>) => {
            runs.push({ provider: runProvider, command, options });
            if (holdRun) {
              await holdRun;
            }
          },
        } as never,
        requireDingTalkActor: identityOptions.requireDingTalkActor,
        requireVerifiedDingTalkActor: identityOptions.requireVerifiedDingTalkActor,
        isActorVerified: identityOptions.isActorVerified,
      },
    );

    await runTest({ socket, runs });
  } finally {
    releaseHeldRun?.();
    // The websocket listener owns the async run. Let its finally block persist
    // execution completion before this fixture closes and swaps the database.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    releaseHeldRun = null;
    holdRun = null;
    connectedClients.clear();
    chatRunRegistry.clearAll();
    if (previousClaudeConfig === undefined) delete process.env.COMIC_CLAUDE_CONFIG_DIR;
    else process.env.COMIC_CLAUDE_CONFIG_DIR = previousClaudeConfig;
    if (previousCodexHome === undefined) delete process.env.COMIC_CODEX_HOME;
    else process.env.COMIC_CODEX_HOME = previousCodexHome;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('an edit resumes through the turn before the one being replaced', async () => {
  await withGateway('claude', async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'a better second prompt',
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'a better second prompt');
    // Inclusive of the row it names, so this is the last turn KEPT.
    assert.equal(runs[0].options.resumeAnchorId, 'e-a1');
    assert.equal(runs[0].options.resumeFromScratch, false);
  });
});

test('editing the first prompt starts the conversation over', async () => {
  await withGateway('claude', async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u1',
      content: 'a better first prompt',
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.resumeAnchorId, undefined);
    assert.equal(runs[0].options.resumeFromScratch, true);
  });
});

test('every subscribed client is told to drop the superseded turns', async () => {
  await withGateway('claude', async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'replacement',
    }));
    await settle();

    const truncation = socket.frames.find((frame) => frame.kind === 'history_truncated');
    assert.ok(truncation, 'a history_truncated frame is emitted');
    assert.equal(truncation?.anchorId, 'e-u2');
    assert.equal(truncation?.sessionId, SESSION_ID);
    // Sequenced like every other run event, so a reconnecting tab replays it.
    assert.equal(typeof truncation?.seq, 'number');
  });
});

test('an edit without an anchor is refused', async () => {
  await withGateway('claude', async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      content: 'no anchor',
    }));
    await settle();

    assert.equal(runs.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'ANCHOR_REQUIRED');
  });
});

test('an anchor the transcript does not hold is refused', async () => {
  await withGateway('claude', async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'not-in-transcript',
      content: 'replacement',
    }));
    await settle();

    assert.equal(runs.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'ANCHOR_NOT_FOUND');
  });
});

test('a provider that cannot re-run from a point is refused rather than sending a new message', async () => {
  await withGateway('cursor', async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.edit-send',
      sessionId: SESSION_ID,
      anchorId: 'e-u2',
      content: 'replacement',
    }));
    await settle();

    assert.equal(runs.length, 0);
    assert.equal(socket.frames.at(-1)?.code, 'EDIT_NOT_SUPPORTED');
  });
});

test('a refused send never rewinds the conversation', async () => {
  await withGateway('codex', async ({ socket, runs }) => {
    // The rewind moves the session onto a different provider transcript and
    // cannot be undone, so a send the gateway is about to refuse must not
    // reach it. A run already in flight is the realistic way that happens: a
    // scheduled message, or another device.
    const realRewind = sessionsService.rewindSessionForEdit;
    let rewound = false;
    sessionsService.rewindSessionForEdit = async () => { rewound = true; };
    holdTheNextRun();

    try {
      socket.emit('message', JSON.stringify({
        type: 'chat.send',
        sessionId: SESSION_ID,
        content: 'a turn that is already running',
      }));
      await settle();
      assert.equal(runs.length, 1);

      socket.emit('message', JSON.stringify({
        type: 'chat.edit-send',
        sessionId: SESSION_ID,
        anchorId: 'turn-b',
        content: 'an edit that arrives too late',
      }));
      await settle();
    } finally {
      sessionsService.rewindSessionForEdit = realRewind;
    }

    assert.equal(rewound, false);
    assert.equal(runs.length, 1);
    assert.equal(socket.frames.at(-1)?.code, 'RUN_IN_PROGRESS');
  }, CODEX_TRANSCRIPT_ROWS);
});

test('a provider that has to branch to rewind is rewound before the run, not during it', async () => {
  await withGateway('codex', async ({ socket, runs }) => {
    // The rewind itself belongs to the provider and is covered there; what
    // this asserts is the gateway's half — that a provider which reports it
    // rewound gets an ordinary run instead of one carrying a resume anchor its
    // runtime would not know what to do with.
    const realRewind = sessionsService.rewindSessionForEdit;
    const rewindCalls: unknown[] = [];
    let truncatedBeforeRewind = false;
    sessionsService.rewindSessionForEdit = async (sessionId: string, keepThroughId: string | null) => {
      truncatedBeforeRewind = socket.frames.some((frame) => frame.kind === 'history_truncated');
      rewindCalls.push({ sessionId, keepThroughId });
    };

    try {
      socket.emit('message', JSON.stringify({
        type: 'chat.edit-send',
        sessionId: SESSION_ID,
        anchorId: 'turn-b',
        content: 'a better second prompt',
      }));
      await settle();
    } finally {
      sessionsService.rewindSessionForEdit = realRewind;
    }

    // Resolved from the real Codex rollout: the turn before the edited one.
    assert.deepEqual(rewindCalls, [{ sessionId: SESSION_ID, keepThroughId: 'turn-a' }]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'a better second prompt');
    assert.equal(runs[0].options.resumeAnchorId, undefined);
    assert.equal(runs[0].options.resumeFromScratch, undefined);

    // Clients still hear about the cut; how it was made is the server's
    // business. And they hear about it first: a rewind that branches waits on
    // a spawned process, and holding the frame until it returned left the
    // replaced message on screen for about a second.
    assert.ok(socket.frames.some((frame) => frame.kind === 'history_truncated'));
    assert.equal(truncatedBeforeRewind, true);
  }, CODEX_TRANSCRIPT_ROWS);
});

test('an actor revoked during async edit preparation cannot reach the provider runtime', async () => {
  let actorVerified = true;
  await withGateway('codex', async ({ socket, runs }) => {
    const realRewind = sessionsService.rewindSessionForEdit;
    sessionsService.rewindSessionForEdit = async () => {
      // Simulates an administrator revoking the registry binding while the
      // provider-owned rewind is awaiting completion.
      actorVerified = false;
    };

    try {
      socket.emit('message', JSON.stringify({
        type: 'chat.edit-send',
        sessionId: SESSION_ID,
        anchorId: 'turn-b',
        content: 'must not run after revocation',
      }));
      await settle();
    } finally {
      sessionsService.rewindSessionForEdit = realRewind;
    }

    assert.equal(runs.length, 0);
    assert.equal(socket.frames.at(-2)?.code, 'IDENTITY_ENROLLMENT_REQUIRED');
    assert.equal(socket.frames.at(-1)?.kind, 'complete');
  }, CODEX_TRANSCRIPT_ROWS, {
    requestUser: {
      id: 1,
      actor: {
        provider: 'dingtalk',
        personId: 'person-1',
        identityStatus: 'verified',
      },
    },
    requireVerifiedDingTalkActor: true,
    isActorVerified: () => actorVerified,
  });
});
