import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import express, { type NextFunction, type Request, type Response } from 'express';

import { collaborationService } from '@/modules/collaboration/collaboration.service.js';
import { createInternalCommitReceiptRoutes } from '@/modules/collaboration/collaboration.routes.js';
import { executionAttributionService } from '@/modules/collaboration/execution-attribution.service.js';
import { closeConnection, getDatabasePath, initializeDatabase } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

test('a Git commit inherits the DingTalk actor identity and records a verified receipt', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousServerPort = process.env.SERVER_PORT;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-attribution-'));
  const repositoryPath = path.join(temporaryDirectory, 'repo');
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  closeConnection();
  await initializeDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/internal/commit-receipts', createInternalCommitReceiptRoutes(
    executionAttributionService,
  ));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    response.status(status).json({ error: error instanceof Error ? error.message : 'failed' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    process.env.SERVER_PORT = String(address.port);
    await execFileAsync('git', ['init', repositoryPath]);
    await writeFile(path.join(repositoryPath, 'story.txt'), 'first panel\n', 'utf8');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'story.txt']);

    const identity = collaborationService.upsertDingTalkActor({
      providerKey: 'comic-test',
      providerName: 'Comic Test',
      externalSubject: 'stable-user-1',
      subjectScope: 'global',
      displayName: '测试开发者',
      badge: '测',
      gitEmail: 'developer@example.com',
    });
    const execution = executionAttributionService.beginExecution({
      userId: identity.user.id,
      sessionId: null,
      provider: 'codex',
      projectPath: repositoryPath,
    });

    const commitResult = await execFileAsync('git', [
      '-C', repositoryPath,
      '-c', 'commit.gpgsign=false',
      'commit',
      '-m',
      [
        'feat: attributed commit',
        '',
        'Agent-Generated-By: Codex',
        'Agent-Task: COMIC-2026-999',
        'Agent-Mode: assisted',
        'Human-Reviewed-By: Pending',
      ].join('\n'),
    ], {
      env: { ...process.env, ...execution.environment },
    });
    assert.doesNotMatch(
      commitResult.stderr,
      /attribution receipt failed/,
      commitResult.stderr,
    );

    const commitMessage = (await execFileAsync(
      'git',
      ['-C', repositoryPath, 'log', '-1', '--format=%B'],
    )).stdout;
    assert.match(commitMessage, new RegExp(`^CloudCLI-Actor-ID: ${identity.actor.actorId}$`, 'm'));
    assert.match(commitMessage, new RegExp(`^CloudCLI-Run-ID: ${execution.runId}$`, 'm'));

    const [receipt] = executionAttributionService.listCommitReceipts({
      taskId: 'COMIC-2026-999',
    });
    assert.ok(receipt);
    assert.equal(receipt.actor.actorId, identity.actor.actorId);
    assert.equal(receipt.authorName, '测试开发者');
    assert.equal(receipt.committerEmail, 'developer@example.com');
    assert.equal(receipt.verificationStatus, 'verified');
    executionAttributionService.completeExecution(execution.runId, 'succeeded');

    // The protection is applied on open even if an old deployment left a
    // broader mode behind.
    await chmod(getDatabasePath(), 0o644);
    closeConnection();
    await initializeDatabase();
    assert.equal((await stat(getDatabasePath())).mode & 0o777, 0o600);
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
    if (previousServerPort === undefined) {
      delete process.env.SERVER_PORT;
    } else {
      process.env.SERVER_PORT = previousServerPort;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
