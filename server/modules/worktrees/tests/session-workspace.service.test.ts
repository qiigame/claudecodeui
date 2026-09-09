import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { sessionWorkspaceService } from '@/modules/worktrees/services/session-workspace.service.js';

const execFileAsync = promisify(execFile);

function deploymentDenied(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && 'statusCode' in error
    && (error as { code?: unknown }).code === 'DEPLOYMENT_CAPABILITY_DENIED'
    && (error as { statusCode?: unknown }).statusCode === 403;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

test('provision rejects product/QA read-only deployments before touching workspace configuration', {
  concurrency: false,
}, async () => {
  const previousProfile = process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
  const previousCapabilities = process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES;
  const previousConfiguration = process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;

  try {
    process.env.CLOUDCLI_DEPLOYMENT_PROFILE = 'product-qa-readonly';
    // A missing configuration path proves the authorization check runs before
    // loadConfiguration() or any filesystem/Git side effect.
    process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES = '{"worktree.mutate":true,"file.write":true,"project.mutate":true,"session.write":true}';
    process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = '/definitely-missing/session-workspaces.json';

    await assert.rejects(
      sessionWorkspaceService.provision({
        sessionId: 'read-only-session',
        sourceProjectPath: '/workspace/source',
        repositoryKeys: [],
      }),
      deploymentDenied,
    );
  } finally {
    if (previousProfile === undefined) delete process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
    else process.env.CLOUDCLI_DEPLOYMENT_PROFILE = previousProfile;
    if (previousCapabilities === undefined) delete process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES;
    else process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES = previousCapabilities;
    if (previousConfiguration === undefined) delete process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
    else process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = previousConfiguration;
  }
});

test('provision rejects a writable profile when any workspace mutation capability is missing', {
  concurrency: false,
}, async () => {
  const previousProfile = process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
  const previousCapabilities = process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES;
  const previousConfiguration = process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;

  try {
    process.env.CLOUDCLI_DEPLOYMENT_PROFILE = 'developer';
    process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES = '{"worktree.mutate":true,"file.write":true,"project.mutate":true,"session.write":false}';
    process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = '/definitely-missing/session-workspaces.json';

    await assert.rejects(
      sessionWorkspaceService.provision({
        sessionId: 'missing-capability-session',
        sourceProjectPath: '/workspace/source',
        repositoryKeys: [],
      }),
      deploymentDenied,
    );
  } finally {
    if (previousProfile === undefined) delete process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
    else process.env.CLOUDCLI_DEPLOYMENT_PROFILE = previousProfile;
    if (previousCapabilities === undefined) delete process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES;
    else process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES = previousCapabilities;
    if (previousConfiguration === undefined) delete process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
    else process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = previousConfiguration;
  }
});

test('provision creates a clean exact-base worktree without touching a dirty source checkout', async () => {
  const previousConfiguration = process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
  const root = await mkdtemp(path.join(tmpdir(), 'cloudcli-session-workspace-'));
  const sourceRoot = path.join(root, 'source');
  const repositoryPath = path.join(sourceRoot, 'repo');
  const remotePath = path.join(root, 'remote.git');
  const workspaceRoot = path.join(root, 'workspaces');
  const configurationPath = path.join(root, 'session-workspaces.json');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await git(root, ['init', '--bare', remotePath]);
    await git(repositoryPath, ['init']);
    await git(repositoryPath, ['config', 'user.name', 'CloudCLI Test']);
    await git(repositoryPath, ['config', 'user.email', 'cloudcli-test@example.invalid']);
    await writeFile(path.join(repositoryPath, 'README.md'), 'remote baseline\n');
    await git(repositoryPath, ['add', 'README.md']);
    await git(repositoryPath, ['commit', '-m', 'baseline']);
    await git(repositoryPath, ['branch', '-M', 'main']);
    await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
    await git(repositoryPath, ['push', '-u', 'origin', 'main']);
    const remoteBaseSha = await git(repositoryPath, ['rev-parse', 'origin/main']);

    await writeFile(configurationPath, JSON.stringify({
      version: 1,
      workspaceRoot,
      projects: [{
        sourceProjectPath: sourceRoot,
        defaultRepositoryKeys: ['repo'],
        repositories: [{
          key: 'repo',
          displayName: 'Repository',
          relativePath: 'repo',
          remoteName: 'origin',
          baseBranch: 'main',
        }],
      }],
    }));
    process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = configurationPath;

    await writeFile(path.join(repositoryPath, 'README.md'), 'local dirty change\n');
    const plan = await sessionWorkspaceService.plan(sourceRoot);
    assert.equal(plan.enabled, true);
    assert.equal(plan.requiresSelection, false);

    const first = await sessionWorkspaceService.provision({
      sessionId: 'session-one',
      sourceProjectPath: sourceRoot,
      repositoryKeys: [],
    });
    const firstRepository = first.repositories[0];
    assert.equal(firstRepository.baseSha, remoteBaseSha);
    assert.equal(await git(firstRepository.worktreePath, ['rev-parse', 'HEAD']), remoteBaseSha);
    assert.equal(await git(firstRepository.worktreePath, ['status', '--porcelain']), '');
    assert.equal(await readFile(path.join(firstRepository.worktreePath, 'README.md'), 'utf8'), 'remote baseline\n');
    assert.match(await readFile(path.join(repositoryPath, 'README.md'), 'utf8'), /local dirty change/);

    const second = await sessionWorkspaceService.provision({
      sessionId: 'session-two',
      sourceProjectPath: sourceRoot,
      repositoryKeys: ['repo'],
    });
    assert.notEqual(second.workspacePath, first.workspacePath);
    assert.notEqual(second.repositories[0].branchName, firstRepository.branchName);

    await sessionWorkspaceService.rollback(second);
    await sessionWorkspaceService.rollback(first);
    assert.equal(await git(repositoryPath, ['branch', '--list', 'cloudcli/session/*']), '');
  } finally {
    if (previousConfiguration === undefined) {
      delete process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
    } else {
      process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = previousConfiguration;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('baseline and managed-workspace checks canonicalize symlink aliases', async () => {
  const previousConfiguration = process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
  const root = await mkdtemp(path.join(tmpdir(), 'cloudcli-session-workspace-alias-'));
  const sourceRoot = path.join(root, 'source-real');
  const sourceAlias = path.join(root, 'source-alias');
  const repositoryPath = path.join(sourceRoot, 'repo');
  const workspaceRoot = path.join(root, 'session-workspaces');
  const workspaceAlias = path.join(root, 'workspace-alias');
  const sessionPath = path.join(workspaceRoot, 'session-one');
  const configurationPath = path.join(root, 'session-workspaces.json');

  try {
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(sessionPath, { recursive: true });
    await symlink(sourceRoot, sourceAlias, 'dir');
    await symlink(workspaceRoot, workspaceAlias, 'dir');
    await writeFile(configurationPath, JSON.stringify({
      version: 1,
      // Use an alias for the workspace root too. The service must retain the
      // canonical root while accepting a not-yet-created session child.
      workspaceRoot: workspaceAlias,
      projects: [{
        sourceProjectPath: sourceAlias,
        defaultRepositoryKeys: ['repo'],
        repositories: [{
          key: 'repo',
          relativePath: 'repo',
          baseBranch: 'main',
        }],
      }],
    }));
    process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = configurationPath;

    assert.equal(sessionWorkspaceService.isProtectedBaselinePath(sourceRoot), true);
    assert.equal(sessionWorkspaceService.isProtectedBaselinePath(sourceAlias), true);
    assert.equal(sessionWorkspaceService.isProtectedBaselinePath(repositoryPath), true);
    assert.equal(await sessionWorkspaceService.plan(sourceRoot).then((plan) => plan.enabled), true);
    assert.equal(sessionWorkspaceService.isManagedWorkspacePath(sessionPath), true);
    assert.equal(
      sessionWorkspaceService.isManagedWorkspacePath(path.join(workspaceAlias, 'session-one')),
      true,
    );
  } finally {
    if (previousConfiguration === undefined) {
      delete process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
    } else {
      process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = previousConfiguration;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a canonical workspace root that overlaps the source checkout through a symlink', async () => {
  const previousConfiguration = process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
  const root = await mkdtemp(path.join(tmpdir(), 'cloudcli-session-workspace-overlap-'));
  const sourceRoot = path.join(root, 'source');
  const workspaceTarget = path.join(sourceRoot, 'session-workspaces');
  const workspaceAlias = path.join(root, 'workspace-alias');
  const configurationPath = path.join(root, 'session-workspaces.json');

  try {
    await mkdir(workspaceTarget, { recursive: true });
    await symlink(workspaceTarget, workspaceAlias, 'dir');
    await writeFile(configurationPath, JSON.stringify({
      version: 1,
      workspaceRoot: workspaceAlias,
      projects: [{
        sourceProjectPath: sourceRoot,
        defaultRepositoryKeys: ['repo'],
        repositories: [{ key: 'repo', relativePath: 'repo', baseBranch: 'main' }],
      }],
    }));
    process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = configurationPath;

    await assert.rejects(
      sessionWorkspaceService.plan(sourceRoot),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && (error as { code?: unknown }).code === 'SESSION_WORKSPACE_CONFIGURATION_INVALID',
    );
  } finally {
    if (previousConfiguration === undefined) {
      delete process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
    } else {
      process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = previousConfiguration;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a configured repository symlink that resolves outside the source checkout', async () => {
  const previousConfiguration = process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
  const root = await mkdtemp(path.join(tmpdir(), 'cloudcli-session-workspace-repository-escape-'));
  const sourceRoot = path.join(root, 'source');
  const outsideRepository = path.join(root, 'outside-repository');
  const repositoryAlias = path.join(sourceRoot, 'repo');
  const workspaceRoot = path.join(root, 'session-workspaces');
  const configurationPath = path.join(root, 'session-workspaces.json');

  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outsideRepository, { recursive: true });
    await symlink(outsideRepository, repositoryAlias, 'dir');
    await writeFile(configurationPath, JSON.stringify({
      version: 1,
      workspaceRoot,
      projects: [{
        sourceProjectPath: sourceRoot,
        defaultRepositoryKeys: ['repo'],
        repositories: [{ key: 'repo', relativePath: 'repo', baseBranch: 'main' }],
      }],
    }));
    process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = configurationPath;

    await assert.rejects(
      sessionWorkspaceService.provision({
        sessionId: 'repository-escape',
        sourceProjectPath: sourceRoot,
        repositoryKeys: [],
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && (error as { code?: unknown }).code === 'SESSION_WORKSPACE_PATH_INVALID',
    );
  } finally {
    if (previousConfiguration === undefined) {
      delete process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
    } else {
      process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = previousConfiguration;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when the configured workspace root is a dangling symlink', async () => {
  const previousConfiguration = process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
  const root = await mkdtemp(path.join(tmpdir(), 'cloudcli-session-workspace-dangling-'));
  const sourceRoot = path.join(root, 'source');
  const workspaceAlias = path.join(root, 'workspace-alias');
  const configurationPath = path.join(root, 'session-workspaces.json');

  try {
    await mkdir(path.join(sourceRoot, 'repo'), { recursive: true });
    await symlink(path.join(root, 'missing-target'), workspaceAlias, 'dir');
    await writeFile(configurationPath, JSON.stringify({
      version: 1,
      workspaceRoot: workspaceAlias,
      projects: [{
        sourceProjectPath: sourceRoot,
        defaultRepositoryKeys: ['repo'],
        repositories: [{ key: 'repo', relativePath: 'repo', baseBranch: 'main' }],
      }],
    }));
    process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = configurationPath;

    await assert.rejects(
      sessionWorkspaceService.plan(sourceRoot),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && (error as { code?: unknown }).code === 'SESSION_WORKSPACE_PATH_INVALID',
    );
  } finally {
    if (previousConfiguration === undefined) {
      delete process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG;
    } else {
      process.env.CLOUDCLI_SESSION_WORKSPACE_CONFIG = previousConfiguration;
    }
    await rm(root, { recursive: true, force: true });
  }
});
