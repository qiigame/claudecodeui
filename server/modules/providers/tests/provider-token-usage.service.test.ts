import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';
import {
  createProviderTokenUsageService,
  summarizeClaudeTokenUsage,
} from '@/modules/providers/services/provider-token-usage.service.js';
import {
  AppError,
  buildClaudeProjectDirectoryName,
  buildClaudeTranscriptFilePath,
  openProviderTranscriptReadHandle,
} from '@/shared/utils.js';
import type {
  AuthenticatedProviderTranscript,
  ProviderTranscriptPathValidationInput,
} from '@/shared/utils.js';

function createSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'app-session',
    provider: 'claude',
    provider_session_id: 'provider-session',
    project_path: null,
    runtime_path: null,
    jsonl_path: null,
    custom_name: null,
    model: null,
    effort: null,
    forked_from_session_id: null,
    isArchived: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function readonlyDeploymentPolicy() {
  return parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
}

/** Creates a transcript in the same provider-owned layout used in production. */
async function createClaudeTranscriptFixture(
  tempDirectory: string,
  providerSessionId: string,
  rows: string[],
) {
  const configDirectory = path.join(tempDirectory, 'claude-config');
  const projectPath = path.join(tempDirectory, 'workspace');
  await mkdir(projectPath, { recursive: true });
  const transcriptPath = buildClaudeTranscriptFilePath(
    configDirectory,
    projectPath,
    providerSessionId,
  );
  if (!transcriptPath) {
    throw new Error('Could not build Claude transcript fixture path.');
  }
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, rows.join('\n'));
  return { configDirectory, projectPath, transcriptPath };
}

/**
 * Test-only opener for deliberately synthetic parser fixtures. It returns an
 * already-open descriptor; the service owns and closes that descriptor, so no
 * test can accidentally restore a validate-then-reopen path seam.
 */
const openFixtureTranscriptForTest = async (
  input: ProviderTranscriptPathValidationInput,
): Promise<AuthenticatedProviderTranscript | null> => {
  const canonicalPath = await realpath(input.candidatePath);
  const opened = await openProviderTranscriptReadHandle(canonicalPath);
  if (!opened) {
    return null;
  }

  return {
    canonicalPath,
    canonicalRoot: path.dirname(canonicalPath),
    device: opened.device,
    inode: opened.inode,
    handle: opened.handle,
    firstRecord: null,
  };
};

test('token usage lookup requires only the app-facing session id for Claude', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-'));

  try {
    const fixture = await createClaudeTranscriptFixture(tempDirectory, 'provider-session', [
      JSON.stringify({
        sessionId: 'provider-session',
        cwd: path.join(tempDirectory, 'workspace'),
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 30,
          },
        },
      }),
      '{incomplete',
    ]);

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        jsonl_path: fixture.transcriptPath,
        project_path: fixture.projectPath,
      }),
      getClaudeConfigDirectory: () => fixture.configDirectory,
      getClaudeContextWindow: () => '180000',
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 155,
      total: 180_000,
      inputTokens: 125,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheTokens: 25,
      breakdown: { input: 125, output: 30 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Claude token usage binds an isolated session to runtime_path instead of a stale source transcript', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-isolated-'));
  const configDirectory = path.join(tempDirectory, 'claude-config');
  const sourcePath = path.join(tempDirectory, 'source');
  const runtimePath = path.join(tempDirectory, 'runtime');
  const providerSessionId = 'isolated-claude-token-usage';

  try {
    await Promise.all([
      mkdir(sourcePath, { recursive: true }),
      mkdir(runtimePath, { recursive: true }),
    ]);
    const sourceProject = buildClaudeProjectDirectoryName(sourcePath, {
      CLAUDE_CONFIG_DIR: configDirectory,
    });
    const runtimeProject = buildClaudeProjectDirectoryName(runtimePath, {
      CLAUDE_CONFIG_DIR: configDirectory,
    });
    assert.ok(sourceProject);
    assert.ok(runtimeProject);
    const sourceTranscript = path.join(
      configDirectory,
      'projects',
      sourceProject,
      `${providerSessionId}.jsonl`,
    );
    const runtimeTranscript = path.join(
      configDirectory,
      'projects',
      runtimeProject,
      `${providerSessionId}.jsonl`,
    );
    await mkdir(path.dirname(sourceTranscript), { recursive: true });
    await writeFile(sourceTranscript, `${JSON.stringify({
      sessionId: providerSessionId,
      cwd: sourcePath,
      type: 'assistant',
      message: { usage: { input_tokens: 7, output_tokens: 2 } },
    })}\n`);

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        jsonl_path: sourceTranscript,
        provider_session_id: providerSessionId,
        project_path: sourcePath,
        runtime_path: runtimePath,
      }),
      getClaudeConfigDirectory: () => configDirectory,
    });

    await assert.rejects(
      () => service.getSessionTokenUsage('app-session'),
      (error: unknown) => error instanceof AppError && error.code === 'SESSION_FILE_NOT_FOUND',
    );

    await mkdir(path.dirname(runtimeTranscript), { recursive: true });
    await writeFile(runtimeTranscript, `${JSON.stringify({
      sessionId: providerSessionId,
      cwd: runtimePath,
      type: 'assistant',
      message: { usage: { input_tokens: 11, output_tokens: 3 } },
    })}\n`);

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.outputTokens, 3);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('production Claude token usage reads from the authenticated descriptor, not a reopened path', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-descriptor-'));
  const configDirectory = path.join(tempDirectory, 'claude-config');
  const projectPath = path.join(tempDirectory, 'workspace');
  const providerSessionId = 'descriptor-bound-claude-token-usage';

  try {
    await mkdir(projectPath, { recursive: true });
    const transcriptPath = buildClaudeTranscriptFilePath(
      configDirectory,
      projectPath,
      providerSessionId,
    );
    assert.ok(transcriptPath);
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({
      sessionId: providerSessionId,
      cwd: projectPath,
      type: 'assistant',
      message: { usage: { input_tokens: 17, output_tokens: 4 } },
    })}\n`);

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        jsonl_path: transcriptPath,
        provider_session_id: providerSessionId,
        project_path: projectPath,
      }),
      getClaudeConfigDirectory: () => configDirectory,
      getClaudeContextWindow: () => '160000',
      // These seams must not be used after the strict validator authenticates
      // the file. If the service reopens the validated string path, the test
      // fails instead of silently weakening the TOCTOU boundary.
      readTextFileTail: () => {
        throw new Error('path-based tail read must not run for production validation');
      },
      readTextFile: () => {
        throw new Error('path-based full read must not run for production validation');
      },
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 21,
      total: 160_000,
      inputTokens: 17,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheTokens: 0,
      breakdown: { input: 17, output: 4 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage uses the latest token_count snapshot', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
            model_context_window: 250_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
      openAuthenticatedTranscriptForTest: openFixtureTranscriptForTest,
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 49,
      total: 250_000,
      inputTokens: 40,
      outputTokens: 9,
      breakdown: { input: 40, output: 9 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage binds an isolated session to runtime_path', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-isolated-'));
  const codexHome = path.join(tempDirectory, 'codex-home');
  const sourcePath = path.join(tempDirectory, 'source');
  const runtimePath = path.join(tempDirectory, 'runtime');
  const providerSessionId = 'isolated-codex-token-usage';
  const sourceTranscript = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '06',
    `rollout-source-${providerSessionId}.jsonl`,
  );
  const runtimeTranscript = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '07',
    `rollout-runtime-${providerSessionId}.jsonl`,
  );

  try {
    await Promise.all([
      mkdir(sourcePath, { recursive: true }),
      mkdir(runtimePath, { recursive: true }),
      mkdir(path.dirname(sourceTranscript), { recursive: true }),
      mkdir(path.dirname(runtimeTranscript), { recursive: true }),
    ]);
    const transcript = (cwd: string, inputTokens: number) => `${[
      JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd, thread_source: 'user' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: inputTokens, output_tokens: 2 },
            model_context_window: 100_000,
          },
        },
      }),
    ].join('\n')}\n`;
    await writeFile(sourceTranscript, transcript(sourcePath, 5));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sourceTranscript,
        provider_session_id: providerSessionId,
        project_path: sourcePath,
        runtime_path: runtimePath,
      }),
      getCodexHomeDirectory: () => codexHome,
    });

    await assert.rejects(
      () => service.getSessionTokenUsage('app-session'),
      (error: unknown) => error instanceof AppError && error.code === 'CODEX_SESSION_FILE_NOT_FOUND',
    );

    await writeFile(runtimeTranscript, transcript(runtimePath, 13));
    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.inputTokens, 13);
    assert.equal(usage.outputTokens, 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('production Codex token usage reads from the authenticated descriptor, not a reopened path', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-descriptor-'));
  const codexHome = path.join(tempDirectory, 'codex-home');
  const projectPath = path.join(tempDirectory, 'workspace');
  const providerSessionId = 'descriptor-bound-codex-token-usage';
  const transcriptPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '09',
    '06',
    `rollout-${providerSessionId}.jsonl`,
  );

  try {
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      mkdir(path.dirname(transcriptPath), { recursive: true }),
    ]);
    await writeFile(transcriptPath, `${[
      JSON.stringify({
        type: 'session_meta',
        payload: { id: providerSessionId, cwd: projectPath, thread_source: 'user' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 19, output_tokens: 6, total_tokens: 25 },
            model_context_window: 120_000,
          },
        },
      }),
    ].join('\n')}\n`);

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: transcriptPath,
        provider_session_id: providerSessionId,
        project_path: projectPath,
      }),
      getCodexHomeDirectory: () => codexHome,
      // A descriptor-backed production read must not fall back to these
      // path-based seams after the opening envelope has been authenticated.
      readTextFileTail: () => {
        throw new Error('path-based tail read must not run for production validation');
      },
      readTextFile: () => {
        throw new Error('path-based full read must not run for production validation');
      },
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 25,
      total: 120_000,
      inputTokens: 19,
      outputTokens: 6,
      breakdown: { input: 19, output: 6 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('OpenCode token usage resolves its provider-native id from the session row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Cursor returns an explicit unsupported token usage result', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'cursor' }),
  });

  const result = await service.getSessionTokenUsage('app-session');

  assert.equal(result.unsupported, true);
  assert.equal(result.used, 0);
  assert.equal(result.total, 0);
});

test('read-only token usage rejects Cursor and OpenCode before opening provider storage', async () => {
  for (const provider of ['cursor', 'opencode'] as const) {
    let databasePathCalls = 0;
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider }),
      getOpenCodeDatabasePath: () => {
        databasePathCalls += 1;
        throw new Error('OpenCode storage must not be opened in read-only mode');
      },
      deploymentPolicy: readonlyDeploymentPolicy(),
    });

    await assert.rejects(
      () => service.getSessionTokenUsage('app-session'),
      (error: unknown) => (
        error instanceof AppError
        && error.code === 'PROVIDER_READ_ONLY_UNSUPPORTED'
        && error.statusCode === 403
        && (error.details as { provider?: string } | undefined)?.provider === provider
      ),
    );
    assert.equal(databasePathCalls, 0);
  }
});

test('token usage uses the construction-time policy when no per-call policy is supplied', async () => {
  const policy = readonlyDeploymentPolicy();
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'opencode' }),
    getOpenCodeDatabasePath: () => {
      throw new Error('OpenCode storage must not be opened in read-only mode');
    },
    deploymentPolicy: policy,
  });
  // The service owns a startup snapshot; later caller-side mutations cannot
  // reopen an ambient provider database.
  policy.profile = 'developer';

  await assert.rejects(
    () => service.getSessionTokenUsage('app-session'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PROVIDER_READ_ONLY_UNSUPPORTED'
      && error.statusCode === 403,
  );
});

test('token usage reports SESSION_NOT_FOUND for an unknown app session id', async () => {
  const service = createProviderTokenUsageService({ getSessionById: () => null });

  await assert.rejects(
    () => service.getSessionTokenUsage('missing-session'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'SESSION_NOT_FOUND'
      && error.statusCode === 404
    ),
  );
});

test('the Claude summarizer reads the newest assistant turn, not the whole conversation', () => {
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 50 } } },
    { type: 'user', message: { role: 'user', content: 'next' } },
    // The newest turn's prompt is the whole context, so its cache_read already
    // includes everything before it. Summing turns would double-count.
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 80 } } },
  ];

  assert.deepEqual(summarizeClaudeTokenUsage(entries, '200000'), {
    used: 4183,
    total: 200_000,
    inputTokens: 4103,
    outputTokens: 80,
    cacheReadTokens: 4000,
    cacheCreationTokens: 100,
    cacheTokens: 4100,
    breakdown: { input: 4103, output: 80 },
  });
});

test('the Claude summarizer skips synthetic rows that carry an all-zero usage block', () => {
  // Interrupts, API errors and "No response requested." are written as
  // assistant rows with a fully zeroed usage block. Reading one as the newest
  // turn dropped the composer counter to 0 until the next turn pushed it back.
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, output_tokens: 80 } } },
    {
      type: 'assistant',
      message: {
        model: '<synthetic>',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];

  assert.equal(summarizeClaudeTokenUsage(entries, '200000').used, 4083);
});

test('the Claude summarizer skips a subagent sidechain turn', () => {
  // A sidechain turn reports the subagent's own context window. Reading it
  // made the counter drop to the subagent's number mid-run.
  const entries = [
    { type: 'assistant', message: { usage: { input_tokens: 3, cache_read_input_tokens: 4000, output_tokens: 80 } } },
    {
      type: 'assistant',
      isSidechain: true,
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 5 } },
    },
  ];

  assert.equal(summarizeClaudeTokenUsage(entries, '200000').used, 4083);
});

test('the Claude summarizer reports zero for a transcript with no assistant turn yet', () => {
  const usage = summarizeClaudeTokenUsage([{ type: 'user', message: { role: 'user', content: 'hi' } }], '200000');

  assert.equal(usage.used, 0);
  assert.equal(usage.total, 200_000);
});

/** Padding rows large enough to push earlier rows out of the 4MB tail window. */
function paddingLines(totalBytes: number): string {
  const line = JSON.stringify({ type: 'attachment', filler: 'x'.repeat(4096) });
  return Array.from({ length: Math.ceil(totalBytes / line.length) }, () => line).join('\n');
}

test('Claude token usage reads only the tail of a large transcript', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-tail-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      paddingLines(5 * 1024 * 1024),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 7, output_tokens: 2 } } }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
      openAuthenticatedTranscriptForTest: openFixtureTranscriptForTest,
      // Reading the whole file here would defeat the tail read; fail loudly.
      readTextFile: () => { throw new Error('full read must not happen when the tail has usage'); },
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.inputTokens, 7);
    assert.equal(usage.outputTokens, 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Claude token usage falls back to the whole file when the tail has no usage row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-fallback-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 11, output_tokens: 3 } } }),
      paddingLines(5 * 1024 * 1024),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
      openAuthenticatedTranscriptForTest: openFixtureTranscriptForTest,
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.inputTokens, 11);
    assert.equal(usage.outputTokens, 3);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage reads only the tail of a large rollout', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-tail-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      paddingLines(5 * 1024 * 1024),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 21, output_tokens: 8, total_tokens: 29 },
            model_context_window: 150_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: sessionFilePath }),
      openAuthenticatedTranscriptForTest: openFixtureTranscriptForTest,
      readTextFile: () => { throw new Error('full read must not happen when the tail has usage'); },
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      total: 150_000,
      inputTokens: 21,
      outputTokens: 8,
      breakdown: { input: 21, output: 8 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage falls back to the whole file when the tail has no token_count row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-fallback-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
        },
      }),
      paddingLines(5 * 1024 * 1024),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'codex', jsonl_path: sessionFilePath }),
      openAuthenticatedTranscriptForTest: openFixtureTranscriptForTest,
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.used, 6);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
