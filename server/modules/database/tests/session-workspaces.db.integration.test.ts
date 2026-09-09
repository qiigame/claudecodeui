import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionWorkspacesDb } from '@/modules/database/repositories/session-workspaces.db.js';

test('session workspace metadata keeps the visible source project and hidden runtime project separate', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'session-workspaces-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');

  try {
    await initializeDatabase();
    const db = getConnection();
    const userResult = db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    ).run('workspace-owner', 'hash');
    const sourceProject = projectsDb.createProjectPath('/workspace/source', 'Source').project;
    assert.ok(sourceProject);
    const runtimeProject = projectsDb.createSessionWorkspacePath('/workspace/runtime/session-1', 'Runtime');
    sessionsDb.createAppSession(
      'session-1',
      'codex',
      sourceProject.project_path,
      'Session',
      runtimeProject.project_path,
    );
    sessionWorkspacesDb.create({
      sessionId: 'session-1',
      sourceProjectId: sourceProject.project_id,
      sourceProjectPath: sourceProject.project_path,
      workspaceProjectId: runtimeProject.project_id,
      workspacePath: runtimeProject.project_path,
      branchPrefix: 'cloudcli/session/session-1',
      createdByUserId: Number(userResult.lastInsertRowid),
      repositories: [{
        repositoryKey: 'repo',
        sourcePath: '/workspace/source/repo',
        worktreePath: '/workspace/runtime/session-1/repo',
        branchName: 'cloudcli/session/session-1',
        remoteName: 'origin',
        baseBranch: 'main',
        baseSha: 'a'.repeat(40),
      }],
    });

    assert.deepEqual(
      projectsDb.getProjectPaths().map((project) => project.project_path),
      ['/workspace/source'],
    );
    assert.equal(sessionsDb.getSessionById('session-1')?.project_path, '/workspace/source');
    assert.equal(sessionsDb.getSessionById('session-1')?.runtime_path, '/workspace/runtime/session-1');
    assert.equal(sessionWorkspacesDb.getBySessionId('session-1')?.repositories[0].baseSha, 'a'.repeat(40));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
