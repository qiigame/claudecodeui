import assert from 'node:assert/strict';
import { access, appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { SessionWorkspaceService } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

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

function readonlyDeploymentPolicy() {
  return parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
}

function unusedWorkspaceService(overrides: Partial<SessionWorkspaceService> = {}): SessionWorkspaceService {
  return {
    plan: async () => ({
      enabled: true,
      requiresSelection: false,
      defaultRepositoryKeys: ['should-not-be-used'],
      repositories: [],
    }),
    provision: async () => {
      throw new Error('readonly session must not provision a workspace');
    },
    rollback: async () => undefined,
    isProtectedBaselinePath: () => false,
    isManagedWorkspacePath: () => false,
    ...overrides,
  };
}

test('product QA session creation keeps DB metadata but skips workspace planning and provisioning', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/tmp/product-qa-session-source';
    const project = projectsDb.createProjectPath(projectPath);
    const projectRow = project.project;
    assert.ok(projectRow);
    let planCalls = 0;
    let provisionCalls = 0;
    const workspaceService = unusedWorkspaceService({
      plan: async () => {
        planCalls += 1;
        return {
          enabled: true,
          requiresSelection: false,
          defaultRepositoryKeys: [],
          repositories: [],
        };
      },
      provision: async () => {
        provisionCalls += 1;
        throw new Error('must not be called');
      },
    });

    const result = await sessionsService.createProjectSession({
      provider: 'claude',
      projectId: projectRow.project_id,
      projectPath,
      initialMessage: 'Read the project',
      repositoryKeys: ['coordination'],
      userId: 7,
      deploymentPolicy: readonlyDeploymentPolicy(),
    }, workspaceService);

    assert.equal(planCalls, 0);
    assert.equal(provisionCalls, 0);
    assert.equal(result.workspace, undefined);
    assert.equal(result.projectPath, projectPath);
    const row = sessionsDb.getSessionById(result.sessionId);
    assert.ok(row);
    assert.equal(row?.runtime_path, null);
    assert.equal(row?.project_path, projectPath);
  });
});

test('custom policy does not infer worktree writes from unrelated mutation capabilities', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/tmp/custom-policy-session-source';
    const project = projectsDb.createProjectPath(projectPath);
    const projectRow = project.project;
    assert.ok(projectRow);
    let planCalls = 0;
    let provisionCalls = 0;
    const workspaceService = unusedWorkspaceService({
      plan: async () => {
        planCalls += 1;
        return {
          enabled: true,
          requiresSelection: false,
          defaultRepositoryKeys: [],
          repositories: [],
        };
      },
      provision: async () => {
        provisionCalls += 1;
        throw new Error('worktree mutation must not be inferred');
      },
    });
    const policy = {
      profile: 'developer' as const,
      capabilities: {
        'session.write': true,
        'provider.write': true,
      },
    };

    const result = await sessionsService.createProjectSession({
      provider: 'claude',
      projectId: projectRow.project_id,
      projectPath,
      initialMessage: 'Keep source checkout',
      repositoryKeys: ['would-be-writable-repo'],
      userId: 7,
      deploymentPolicy: policy,
    }, workspaceService);

    assert.equal(planCalls, 0);
    assert.equal(provisionCalls, 0);
    assert.equal(result.workspace, undefined);
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.runtime_path, null);
  });
});

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('new app sessions do not resolve their app id as a provider-native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('new-app-session', 'codex', '/tmp/session-id-copy-project');

    assert.equal(sessionsService.resolveProviderSessionId('new-app-session'), null);
    // Unknown ids remain compatible with direct provider callers that already
    // hold a native id but have not been indexed by the app yet.
    assert.equal(sessionsService.resolveProviderSessionId('unindexed-native-id'), 'unindexed-native-id');
  });
});

test('app session names use at most four whole words from the initial message', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession(
      'codex',
      '/tmp/session-name-project',
      '  supercalifragilisticexpialidocious\nsecond   third fourth fifth  ',
    );

    assert.equal(result.sessionName, 'supercalifragilisticexpialidocious second third fourth');
    assert.equal(
      sessionsDb.getSessionById(result.sessionId)?.custom_name,
      'supercalifragilisticexpialidocious second third fourth',
    );
  });
});

test('app sessions without message text receive a stable fallback name', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession('claude', '/tmp/attachment-only-project', '  \n ');

    assert.equal(result.sessionName, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.custom_name, 'Untitled Session');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('product QA can change session metadata but cannot delete provider transcripts', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-delete-'));
  const transcriptPath = path.join(transcriptDirectory, 'session.jsonl');

  try {
    await withIsolatedDatabase(async () => {
      await writeFile(transcriptPath, '{"type":"user"}\n', 'utf8');
      sessionsDb.createSession(
        'readonly-delete-session',
        'claude',
        '/tmp/readonly-delete-project',
        'Readonly delete',
        undefined,
        undefined,
        transcriptPath,
      );
      const policy = readonlyDeploymentPolicy();

      const archived = await sessionsService.deleteOrArchiveSessionById(
        'readonly-delete-session',
        { force: false },
        policy,
      );
      assert.equal(archived.action, 'archived');
      assert.equal(sessionsDb.getSessionById('readonly-delete-session')?.isArchived, 1);

      sessionsDb.updateSessionIsArchived('readonly-delete-session', false);
      await assert.rejects(
        () => sessionsService.deleteOrArchiveSessionById(
          'readonly-delete-session',
          { force: true, deletedFromDisk: true },
          policy,
        ),
        (error: Error & { code?: string; statusCode?: number }) => (
          error.code === 'DEPLOYMENT_CAPABILITY_DENIED' && error.statusCode === 403
        ),
      );
      assert.ok(sessionsDb.getSessionById('readonly-delete-session'));
      await access(transcriptPath);

      const metadataDeleted = await sessionsService.deleteOrArchiveSessionById(
        'readonly-delete-session',
        { force: true, deletedFromDisk: false },
        policy,
      );
      assert.equal(metadataDeleted.action, 'deleted');
      assert.equal(metadataDeleted.deletedFromDisk, false);
      assert.equal(sessionsDb.getSessionById('readonly-delete-session'), null);
      await access(transcriptPath);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('recent sessions map project metadata and preserve database pagination', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'older-session',
      'claude',
      '/tmp/recent-project',
      'Older conversation',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    );
    sessionsDb.createSession(
      'newer-session',
      'codex',
      '/tmp/recent-project',
      'Newer conversation',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
    );
    projectsDb.updateCustomProjectName('/tmp/recent-project', 'Recent Project');

    const project = projectsDb.getProjectPath('/tmp/recent-project');
    const page = sessionsService.listRecentSessions(1, 0);

    assert.deepEqual(page, {
      conversations: [{
        sessionId: 'newer-session',
        provider: 'codex',
        projectId: project?.project_id ?? null,
        projectDisplayName: 'Recent Project',
        sessionTitle: 'Newer conversation',
        lastActivity: '2026-08-01T11:00:00.000Z',
      }],
      total: 2,
      hasMore: true,
    });
  });
});

/** One Claude transcript row of user or assistant text, linked by uuid chain. */
function claudeTextRow(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  ordinal: number,
): Record<string, unknown> {
  return {
    type: role,
    uuid: `row-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `row-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('history pages are sliced from the cached full transcript and see appended rows', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-history-'));
  const sessionId = 'claude-history-cache-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      const rows = [
        claudeTextRow(sessionId, 'user', 'one', 0),
        claudeTextRow(sessionId, 'assistant', 'reply one', 1),
        claudeTextRow(sessionId, 'user', 'two', 2),
        claudeTextRow(sessionId, 'assistant', 'reply two', 3),
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/history-cache-project',
        'History cache conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
        transcriptPath,
      );

      const page = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(page.total, 4);
      assert.equal(page.hasMore, true);
      assert.deepEqual(page.messages.map((message) => message.content), ['two', 'reply two']);

      // A row appended after the page was cached must appear on the next read.
      await appendFile(
        transcriptPath,
        `${JSON.stringify(claudeTextRow(sessionId, 'user', 'three', 4))}\n`,
        'utf8',
      );
      const refreshed = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(refreshed.total, 5);
      assert.deepEqual(refreshed.messages.map((message) => message.content), ['reply two', 'three']);

      // An older page keeps the tail-offset contract while served from cache.
      const older = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 2 });
      assert.deepEqual(older.messages.map((message) => message.content), ['reply one', 'two']);
      assert.equal(older.hasMore, true);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('history resolves a provider-native alias to the canonical app session', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-native-history-'));
  const appSessionId = 'app-native-history-session';
  const providerSessionId = 'claude-native-history-session';
  const transcriptPath = path.join(transcriptDirectory, `${providerSessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      const rows = [
        claudeTextRow(providerSessionId, 'user', 'native prompt', 0),
        claudeTextRow(providerSessionId, 'assistant', 'native response', 1),
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

      // Reproduce an app-created session after the provider watcher has
      // already indexed the same transcript. assignProviderSessionId merges
      // the watcher row into the stable app-facing row and preserves its path.
      sessionsDb.createSession(
        providerSessionId,
        'claude',
        '/tmp/native-history-project',
        'Native history conversation',
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:10.000Z',
        transcriptPath,
      );
      sessionsDb.createAppSession(
        appSessionId,
        'claude',
        '/tmp/native-history-project',
        'App history conversation',
      );
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);

      const history = await sessionsService.fetchHistory(providerSessionId, { limit: null, offset: 0 });

      assert.equal(history.total, 2);
      assert.deepEqual(history.messages.map((message) => message.content), [
        'native prompt',
        'native response',
      ]);
      assert.ok(history.messages.every((message) => message.sessionId === appSessionId));
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('read-only history rejects Cursor and OpenCode before provider storage access', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    for (const provider of ['cursor', 'opencode'] as const) {
      sessionsDb.createSession(
        `${provider}-native-history`,
        provider,
        `/tmp/${provider}-readonly-history-project`,
        'Read-only history',
        undefined,
        undefined,
        `/ambient/${provider}/provider-storage.jsonl`,
      );

      await assert.rejects(
        () => sessionsService.fetchHistory(`${provider}-native-history`, {}, readonlyDeploymentPolicy()),
        (error: unknown) => {
          const typedError = error as {
            code?: string;
            statusCode?: number;
            details?: { provider?: string };
          };
          return typedError.code === 'PROVIDER_READ_ONLY_UNSUPPORTED'
            && typedError.statusCode === 403
            && typedError.details?.provider === provider;
        },
      );
    }
  });
});
