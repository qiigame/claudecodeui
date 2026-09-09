import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Set the managed profile before importing the service. The service captures
// this policy once at module startup, matching an alternate production caller
// that omits the explicit HTTP composition-root snapshot.
process.env.CLOUDCLI_DEPLOYMENT_PROFILE = 'product-qa-readonly';

const {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} = await import('@/modules/database/index.js');
const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-readonly-fallback-db-'));

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

test('startup readonly fallback skips worktree planning when a direct caller omits policy', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const projectPath = '/tmp/product-qa-startup-fallback-source';
    const project = projectsDb.createProjectPath(projectPath).project;
    assert.ok(project);

    let planCalls = 0;
    let provisionCalls = 0;
    const result = await sessionsService.createProjectSession({
      provider: 'claude',
      projectId: project.project_id,
      projectPath,
      initialMessage: 'Inspect this project',
      repositoryKeys: ['must-not-be-used'],
      userId: 7,
    }, {
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
        throw new Error('readonly fallback must not provision a workspace');
      },
      rollback: async () => undefined,
      isProtectedBaselinePath: () => false,
      isManagedWorkspacePath: () => false,
    });

    assert.equal(planCalls, 0);
    assert.equal(provisionCalls, 0);
    assert.equal(result.workspace, undefined);
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.runtime_path, null);
  });
});

test('startup readonly fallback refuses transcript deletion when a direct caller omits policy', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-readonly-fallback-delete-'));
  const transcriptPath = path.join(transcriptDirectory, 'session.jsonl');

  try {
    await withIsolatedDatabase(async () => {
      await writeFile(transcriptPath, '{"type":"user"}\n', 'utf8');
      sessionsDb.createSession(
        'readonly-fallback-delete',
        'claude',
        transcriptDirectory,
        'Readonly fallback delete',
        undefined,
        undefined,
        transcriptPath,
      );

      await assert.rejects(
        () => sessionsService.deleteOrArchiveSessionById(
          'readonly-fallback-delete',
          { force: true, deletedFromDisk: true },
        ),
        (error: Error & { code?: string; statusCode?: number }) => (
          error.code === 'DEPLOYMENT_CAPABILITY_DENIED' && error.statusCode === 403
        ),
      );
      assert.ok(sessionsDb.getSessionById('readonly-fallback-delete'));
      await access(transcriptPath);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});
