import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';
import providerRouter, {
  createProviderRouter,
  redactProviderMcpServerSecrets,
} from '@/modules/providers/provider.routes.js';
import { AppError, buildClaudeProjectDirectoryName } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
  router = providerRouter,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const testUser = userDb.createUser('route-test-user', 'not-used');
  const workspacePathCandidate = path.join(tempDirectory, 'workspace');
  await mkdir(workspacePathCandidate, { recursive: true });
  // macOS temporary roots can themselves be symlinked (/var -> /private/var).
  // Store the canonical path so the managed read guard exercises the same
  // anti-symlink invariant used in production.
  const workspacePath = await realpath(workspacePathCandidate);
  projectsDb.createProjectPath(workspacePath);

  const app = express()
    .use(express.json())
    .use((req, _res, next) => {
      (req as Request & { user?: { id: number } }).user = { id: Number(testUser.id) };
      next();
    })
    .use('/api/providers', router);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, workspacePath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('managed MCP catalog redaction never returns bearer values', () => {
  const redacted = redactProviderMcpServerSecrets({
    provider: 'codex',
    name: 'cloudcli-browser',
    scope: 'user',
    transport: 'stdio',
    command: 'node',
    args: ['--token', 'secret-token', '--header', 'Authorization: Bearer secret-token', '--header=Authorization=Bearer secret-token'],
    env: { CLOUDCLI_BROWSER_USE_MCP_TOKEN: 'secret-token' },
    url: 'https://example.test/mcp?token=secret-token',
    headers: { Authorization: 'Bearer secret-token' },
    envHttpHeaders: { Authorization: 'Bearer secret-token' },
  });

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(redacted.env?.CLOUDCLI_BROWSER_USE_MCP_TOKEN, '[redacted]');
  assert.equal(redacted.headers?.Authorization, '[redacted]');
  assert.equal(redacted.envHttpHeaders?.Authorization, '[redacted]');
  assert.deepEqual(redacted.args, ['--token', '[redacted]', '--header', '[redacted]', '[redacted]']);
  assert.match(redacted.url ?? '', /token=%5Bredacted%5D/);
});

test('session creation route names a CloudCLI session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const previousCodexHome = process.env.COMIC_CODEX_HOME;
    const codexHome = path.join(path.dirname(workspacePath), 'search-codex-home');
    const transcriptPath = path.join(
      codexHome,
      'sessions',
      '2026',
      '08',
      '12',
      'rollout-transcript-session.jsonl',
    );
    process.env.COMIC_CODEX_HOME = codexHome;
    try {
      sessionsDb.createAppSession(
        'title-only-session',
        'codex',
        workspacePath,
        'Release planning notes',
      );
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'transcript-session', cwd: workspacePath, thread_source: 'user' },
      })}\n${JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-08-12T09:00:00.000Z',
        payload: {
          type: 'user_message',
          kind: 'plain',
          message: 'Release planning also appears in this conversation.',
        },
      })}\n`);
      sessionsDb.createSession(
        'transcript-session',
        'codex',
        workspacePath,
        'Unrelated session',
        undefined,
        undefined,
        transcriptPath,
      );
      const escapedTranscriptPath = path.join(path.dirname(workspacePath), 'outside-search.jsonl');
      await writeFile(escapedTranscriptPath, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'escaped-session', cwd: workspacePath, thread_source: 'user' },
      })}\n${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          kind: 'plain',
          message: 'Release planning secret outside configured root.',
        },
      })}\n`);
      sessionsDb.createSession(
        'escaped-session',
        'codex',
        workspacePath,
        'Escaped transcript',
        undefined,
        undefined,
        escapedTranscriptPath,
      );

      const response = await fetch(
        `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
      );
      const eventStream = await response.text();
      assert.equal(eventStream.includes('secret outside configured root'), false);
      const titleEventIndex = eventStream.indexOf('event: title-results');
      const conversationEventIndex = eventStream.indexOf('event: result');
      const doneEventIndex = eventStream.indexOf('event: done');

      assert.equal(response.status, 200);
      assert.ok(titleEventIndex >= 0);
      assert.ok(conversationEventIndex > titleEventIndex);
      assert.ok(doneEventIndex > titleEventIndex);

      const titleDataLine = eventStream
        .slice(titleEventIndex, conversationEventIndex)
        .split('\n')
        .find((line) => line.startsWith('data: '));
      assert.ok(titleDataLine);

      const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
        titleResults: Array<{
          sessionId: string;
          sessionTitle: string;
          provider: string;
        }>;
      };
      assert.equal(titlePayload.titleResults.length, 1);
      assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
      assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
      assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.COMIC_CODEX_HOME;
      } else {
        process.env.COMIC_CODEX_HOME = previousCodexHome;
      }
    }
  });
});

test('conversation search binds isolated sessions to their runtime cwd', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const previousCodexHome = process.env.COMIC_CODEX_HOME;
    const codexHome = path.join(path.dirname(workspacePath), 'isolated-search-codex-home');
    const runtimePathCandidate = path.join(path.dirname(workspacePath), 'isolated-search-runtime');
    const providerSessionId = 'isolated-search-session';
    const appSessionId = 'app-isolated-search-session';
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
    process.env.COMIC_CODEX_HOME = codexHome;

    try {
      await Promise.all([
        mkdir(runtimePathCandidate, { recursive: true }),
        mkdir(path.dirname(sourceTranscript), { recursive: true }),
        mkdir(path.dirname(runtimeTranscript), { recursive: true }),
      ]);
      const runtimePath = await realpath(runtimePathCandidate);
      const writeTranscript = async (filePath: string, cwd: string, message: string) => {
        await writeFile(filePath, `${JSON.stringify({
          type: 'session_meta',
          payload: { id: providerSessionId, cwd, thread_source: 'user' },
        })}\n${JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', kind: 'plain', message },
        })}\n`);
      };

      await writeTranscript(sourceTranscript, workspacePath, 'isolated source leak marker');
      sessionsDb.createAppSession(
        appSessionId,
        'codex',
        workspacePath,
        'Unrelated isolated title',
        runtimePath,
      );
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);
      sessionsDb.createSession(
        providerSessionId,
        'codex',
        workspacePath,
        undefined,
        undefined,
        undefined,
        sourceTranscript,
      );

      const staleResponse = await fetch(
        `${baseUrl}/api/providers/search/sessions?q=isolated%20source%20leak%20marker&limit=50`,
      );
      const staleEvents = await staleResponse.text();
      assert.equal(staleResponse.status, 200);
      assert.equal(staleEvents.includes('isolated source leak marker'), false);

      await writeTranscript(runtimeTranscript, runtimePath, 'isolated runtime visible marker');
      sessionsDb.createSession(
        providerSessionId,
        'codex',
        runtimePath,
        undefined,
        undefined,
        undefined,
        runtimeTranscript,
      );

      const runtimeResponse = await fetch(
        `${baseUrl}/api/providers/search/sessions?q=isolated%20runtime%20visible%20marker&limit=50`,
      );
      const runtimeEvents = await runtimeResponse.text();
      assert.equal(runtimeResponse.status, 200);
      assert.equal(runtimeEvents.includes('isolated runtime visible marker'), true);
      assert.equal(runtimeEvents.includes(appSessionId), true);
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.COMIC_CODEX_HOME;
      } else {
        process.env.COMIC_CODEX_HOME = previousCodexHome;
      }
    }
  });
});

test('Claude active-model lookup rejects a stale source transcript for an isolated session', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const previousClaudeConfig = process.env.COMIC_CLAUDE_CONFIG_DIR;
    const configDirectory = path.join(path.dirname(workspacePath), 'isolated-model-claude-config');
    const runtimePathCandidate = path.join(path.dirname(workspacePath), 'isolated-model-runtime');
    const providerSessionId = 'isolated-model-session';
    const appSessionId = 'app-isolated-model-session';
    process.env.COMIC_CLAUDE_CONFIG_DIR = configDirectory;

    try {
      await mkdir(runtimePathCandidate, { recursive: true });
      const runtimePath = await realpath(runtimePathCandidate);
      const sourceProjectKey = buildClaudeProjectDirectoryName(workspacePath, {
        CLAUDE_CONFIG_DIR: configDirectory,
      });
      const runtimeProjectKey = buildClaudeProjectDirectoryName(runtimePath, {
        CLAUDE_CONFIG_DIR: configDirectory,
      });
      assert.ok(sourceProjectKey);
      assert.ok(runtimeProjectKey);
      const sourceTranscript = path.join(
        configDirectory,
        'projects',
        sourceProjectKey,
        `${providerSessionId}.jsonl`,
      );
      const runtimeTranscript = path.join(
        configDirectory,
        'projects',
        runtimeProjectKey,
        `${providerSessionId}.jsonl`,
      );
      const writeInit = async (filePath: string, cwd: string, model: string) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `${JSON.stringify({
          sessionId: providerSessionId,
          cwd,
          type: 'system',
          subtype: 'init',
          model,
        })}\n`);
      };

      await writeInit(sourceTranscript, workspacePath, 'source-model-must-not-leak');
      sessionsDb.createAppSession(
        appSessionId,
        'claude',
        workspacePath,
        'Isolated model lookup',
        runtimePath,
      );
      sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);
      sessionsDb.createSession(
        providerSessionId,
        'claude',
        workspacePath,
        undefined,
        undefined,
        undefined,
        sourceTranscript,
      );

      const staleResponse = await fetch(
        `${baseUrl}/api/providers/claude/sessions/${appSessionId}/active-model`,
      );
      const stalePayload = await staleResponse.json() as { data?: { model?: string } };
      assert.equal(staleResponse.status, 200);
      assert.notEqual(stalePayload.data?.model, 'source-model-must-not-leak');

      await writeInit(runtimeTranscript, runtimePath, 'runtime-model-visible');
      sessionsDb.createSession(
        providerSessionId,
        'claude',
        runtimePath,
        undefined,
        undefined,
        undefined,
        runtimeTranscript,
      );

      const runtimeResponse = await fetch(
        `${baseUrl}/api/providers/claude/sessions/${appSessionId}/active-model`,
      );
      const runtimePayload = await runtimeResponse.json() as { data?: { model?: string } };
      assert.equal(runtimeResponse.status, 200);
      assert.equal(runtimePayload.data?.model, 'runtime-model-visible');
    } finally {
      if (previousClaudeConfig === undefined) {
        delete process.env.COMIC_CLAUDE_CONFIG_DIR;
      } else {
        process.env.COMIC_CLAUDE_CONFIG_DIR = previousClaudeConfig;
      }
    }
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});

test('Codex MCP route accepts only supported default tool approval modes', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const createResponse = await fetch(`${baseUrl}/api/providers/codex/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'browser-test',
        scope: 'project',
        transport: 'stdio',
        command: 'node',
        args: ['browser-mcp.js'],
        workspacePath,
        defaultToolsApprovalMode: 'approve',
      }),
    });
    const createPayload = await createResponse.json() as {
      data: { server: { defaultToolsApprovalMode?: string } };
    };

    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.server.defaultToolsApprovalMode, 'approve');

    const invalidResponse = await fetch(`${baseUrl}/api/providers/codex/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'browser-test-invalid',
        scope: 'project',
        transport: 'stdio',
        command: 'node',
        workspacePath,
        defaultToolsApprovalMode: 'always',
      }),
    });
    const invalidPayload = await invalidResponse.json() as { error: { code: string } };

    assert.equal(invalidResponse.status, 400);
    assert.equal(invalidPayload.error.code, 'INVALID_MCP_TOOLS_APPROVAL_MODE');
  });
});

test('product QA read-only policy keeps provider catalogs readable but blocks configuration writes', async () => {
  const readonlyRouter = createProviderRouter({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  });

  await withProviderServer(async (baseUrl) => {
    const readResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    assert.equal(readResponse.status, 200);

    const modelWriteResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Should Not Persist', id: 'blocked/model' }),
    });
    assert.equal(modelWriteResponse.status, 403);
    const modelWritePayload = await modelWriteResponse.json() as { error: { code: string } };
    assert.equal(modelWritePayload.error.code, 'DEPLOYMENT_CAPABILITY_DENIED');

    const mcpWriteResponse = await fetch(`${baseUrl}/api/providers/codex/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'blocked-mcp', scope: 'user', transport: 'stdio', command: 'node',
      }),
    });
    assert.equal(mcpWriteResponse.status, 403);
    const mcpWritePayload = await mcpWriteResponse.json() as { error: { code: string } };
    assert.equal(mcpWritePayload.error.code, 'DEPLOYMENT_CAPABILITY_DENIED');
}, readonlyRouter);
});

test('session listing and conversation search require the explicit session.read capability', async () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_CAPABILITY_SESSION_READ: 'false',
  });
  const readonlyRouter = createProviderRouter({ deploymentPolicy: policy });

  await withProviderServer(async (baseUrl) => {
    const recentResponse = await fetch(`${baseUrl}/api/providers/sessions/recent`);
    const recentPayload = await recentResponse.json() as { error?: { code?: string } };
    assert.equal(recentResponse.status, 403);
    assert.equal(recentPayload.error?.code, 'DEPLOYMENT_CAPABILITY_DENIED');

    // The guard must run before the SSE headers are written; otherwise a
    // denied request would look like a successful stream and leak route
    // behavior to a profile that explicitly disabled session reads.
    const searchResponse = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=read%20only`,
    );
    const searchPayload = await searchResponse.json() as { error?: { code?: string } };
    assert.equal(searchResponse.status, 403);
    assert.equal(searchPayload.error?.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  }, readonlyRouter);
});

test('provider read routes require their own explicit capability', async () => {
  const capabilityCases = [
    {
      disabledCapability: 'CLOUDCLI_CAPABILITY_PROVIDER_RUNTIME',
      endpoints: [
        '/api/providers/codex/auth/status',
        '/api/providers/codex/models',
        '/api/providers/codex/sessions/guard-probe/active-model',
        '/api/providers/capabilities',
        '/api/providers/codex/capabilities',
      ],
    },
    {
      disabledCapability: 'CLOUDCLI_CAPABILITY_SKILL_READ',
      endpoints: ['/api/providers/codex/skills'],
    },
    {
      disabledCapability: 'CLOUDCLI_CAPABILITY_MCP_READ',
      endpoints: ['/api/providers/codex/mcp/servers'],
    },
    {
      disabledCapability: 'CLOUDCLI_CAPABILITY_SESSION_READ',
      endpoints: [
        '/api/providers/codex/sessions/guard-probe/active-model',
        '/api/providers/sessions/running',
        '/api/providers/sessions/recent',
        '/api/providers/sessions/archived',
        '/api/providers/sessions/guard-probe/provider-id',
        '/api/providers/sessions/guard-probe/token-usage',
        '/api/providers/sessions/guard-probe',
        '/api/providers/sessions/guard-probe/messages',
        '/api/providers/search/sessions?q=guard',
      ],
    },
  ] as const;

  for (const { disabledCapability, endpoints } of capabilityCases) {
    const readonlyRouter = createProviderRouter({
      deploymentPolicy: parseDeploymentPolicy({
        CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
        [disabledCapability]: 'false',
      }),
    });

    await withProviderServer(async (baseUrl) => {
      for (const endpoint of endpoints) {
        const response = await fetch(`${baseUrl}${endpoint}`);
        const payload = await response.json() as { error?: { code?: string } };
        assert.equal(response.status, 403, `${disabledCapability}: ${endpoint}`);
        assert.equal(
          payload.error?.code,
          'DEPLOYMENT_CAPABILITY_DENIED',
          `${disabledCapability}: ${endpoint}`,
        );
      }
    }, readonlyRouter);
  }
});

test('provider mutation guards canonicalize case and trailing slashes', async () => {
  const readonlyRouter = createProviderRouter({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  });

  await withProviderServer(async (baseUrl) => {
    // Express route matching is case-insensitive and accepts a trailing slash.
    // The pre-route capability matrix must make the same authorization
    // decision for this spelling as for `/codex/models`.
    const response = await fetch(`${baseUrl}/api/providers/CODEX/MODELS/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Should Not Persist', id: 'blocked/case' }),
    });
    const payload = await response.json() as { error?: { code?: string } };

    assert.equal(response.status, 403);
    assert.equal(payload.error?.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  }, readonlyRouter);
});

test('product QA provider catalog reads cannot scan an unregistered workspace path', async () => {
  const readonlyRouter = createProviderRouter({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  });

  await withProviderServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/providers/claude/skills?workspacePath=${encodeURIComponent('/tmp')}`,
    );
    const payload = await response.json() as { error?: { code: string } };

    assert.equal(response.status, 404);
    assert.equal(payload.error?.code, 'PROJECT_NOT_FOUND');
  }, readonlyRouter);
});

test('product QA provider catalog reads use the canonical registered workspace path', async () => {
  const readonlyRouter = createProviderRouter({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  });

  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(
      `${baseUrl}/api/providers/claude/mcp/servers?workspacePath=${encodeURIComponent(`${workspacePath}/.`)}`,
    );
    const payload = await response.json() as { data?: { provider: string } };

    assert.equal(response.status, 200);
    assert.equal(payload.data?.provider, 'claude');
  }, readonlyRouter);
});

test('product QA session creation binds the source project without provisioning a worktree', async () => {
  const readonlyRouter = createProviderRouter({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  });

  await withProviderServer(async (baseUrl, workspacePath) => {
    // No CLOUDCLI_SESSION_WORKSPACE_CONFIG is installed in this test.  A
    // readonly request must still succeed because it never calls the
    // workspace planner/provisioner.
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        projectPath: workspacePath,
        initialMessage: 'Inspect source only',
        repositoryKeys: ['would-be-writable-repo'],
      }),
    });
    const payload = await response.json() as {
      data?: { sessionId: string; projectPath: string; workspace?: unknown };
      error?: { code: string };
    };

    assert.equal(response.status, 201);
    assert.ok(payload.data?.sessionId);
    assert.equal(payload.data?.projectPath, workspacePath);
    assert.equal(payload.data?.workspace, undefined);
    const row = sessionsDb.getSessionById(payload.data!.sessionId);
    assert.equal(row?.project_path, workspacePath);
    assert.equal(row?.runtime_path, null);
  }, readonlyRouter);
});

test('product QA session metadata mutations remain available while fork and transcript deletion are denied', async () => {
  const readonlyRouter = createProviderRouter({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
  });

  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('readonly-route-session', 'claude', workspacePath, 'Read only');

    const renameResponse = await fetch(`${baseUrl}/api/providers/sessions/readonly-route-session`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Renamed safely' }),
    });
    assert.equal(renameResponse.status, 200);
    assert.equal(sessionsDb.getSessionById('readonly-route-session')?.custom_name, 'Renamed safely');

    const forkResponse = await fetch(`${baseUrl}/api/providers/sessions/readonly-route-session/fork`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const forkPayload = await forkResponse.json() as { error?: { code: string } };
    assert.equal(forkResponse.status, 403);
    assert.equal(forkPayload.error?.code, 'DEPLOYMENT_CAPABILITY_DENIED');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/sessions/readonly-route-session?force=true`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as { error?: { code: string } };
    assert.equal(deleteResponse.status, 403);
    assert.equal(deletePayload.error?.code, 'DEPLOYMENT_CAPABILITY_DENIED');
    assert.ok(sessionsDb.getSessionById('readonly-route-session'));

    // Explicit metadata-only deletion is safe and remains available to QA.
    const metadataDeleteResponse = await fetch(
      `${baseUrl}/api/providers/sessions/readonly-route-session?force=true&deletedFromDisk=false`,
      { method: 'DELETE' },
    );
    assert.equal(metadataDeleteResponse.status, 200);
    assert.equal(sessionsDb.getSessionById('readonly-route-session'), null);
  }, readonlyRouter);
});
