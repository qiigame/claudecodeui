import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { AppError } from '@/shared/utils.js';

type TestDependencies = Parameters<typeof startCloneProject>[2];

function buildDependencies(overrides: Partial<NonNullable<TestDependencies>> = {}): NonNullable<TestDependencies> {
  return {
    validatePath: async () => ({ valid: true, resolvedPath: '/workspace/root' }),
    ensureDirectory: async () => undefined,
    pathExists: async () => false,
    removePath: async () => undefined,
    getGithubTokenById: async () => ({ github_token: 'token-value' }),
    spawnGitClone: () => {
      throw new Error('spawnGitClone should be overridden in this test');
    },
    registerProject: async () => ({ project: { projectId: 'project-1' } }),
    logError: () => undefined,
    ...overrides,
  };
}

function createMockGitProcess() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };

  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.kill = () => {
    emitter.emit('close', null);
  };

  return emitter;
}

test('startCloneProject rejects when workspace path is missing', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '',
          githubUrl: 'https://github.com/example/repo',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'WORKSPACE_PATH_REQUIRED');
      return true;
    },
  );
});

test('startCloneProject rejects when github URL is missing', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: '',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GITHUB_URL_REQUIRED');
      return true;
    },
  );
});

test('startCloneProject rejects github URL values that begin with option prefixes', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: '--upload-pack=malicious',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_GITHUB_URL');
      return true;
    },
  );
});

test('startCloneProject rejects repository URLs whose derived target is not a fresh child directory', async () => {
  for (const githubUrl of [
    'https://github.com/example/..',
    'https://github.com/example/.',
    'git@github.com:example/..\\evil.git',
  ]) {
    await assert.rejects(
      async () =>
        startCloneProject(
          {
            workspacePath: '/workspace/root',
            githubUrl,
            userId: 1,
          },
          {
            onProgress: () => undefined,
            onComplete: () => undefined,
          },
          buildDependencies(),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_CLONE_TARGET');
        return true;
      },
    );
  }
});

test('startCloneProject rejects when selected github token does not exist', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: 'https://github.com/example/repo',
          githubTokenId: 12,
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies({
          getGithubTokenById: async () => null,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GITHUB_TOKEN_NOT_FOUND');
      return true;
    },
  );
});

test('startCloneProject completes and emits complete payload when git exits successfully', async () => {
  const gitProcess = createMockGitProcess();
  const progressMessages: string[] = [];
  let completePayload: { project: Record<string, unknown>; message: string } | null = null;
  let capturedProjectPath = '';
  let capturedCustomName = '';

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      userId: 1,
    },
    {
      onProgress: (message) => {
        progressMessages.push(message);
      },
      onComplete: (payload: { project: Record<string, unknown>; message: string }) => {
        completePayload = payload;
      },
    },
    buildDependencies({
      spawnGitClone: () => gitProcess as any,
      registerProject: async (projectPath, customName) => {
        capturedProjectPath = projectPath;
        capturedCustomName = customName;
        return { project: { projectId: 'project-1', path: projectPath } };
      },
    }),
  );

  gitProcess.stderr.write('Receiving objects: 1%\r');
  gitProcess.stderr.write('Receiving objects: 100%\n');
  gitProcess.emit('close', 0);
  await operation.waitForCompletion;

  assert.ok(progressMessages.some((message) => message.includes("Cloning into 'repo'")));
  assert.ok(progressMessages.some((message) => message.includes('Receiving objects: 1%')));
  assert.ok(progressMessages.some((message) => message.includes('Receiving objects: 100%')));
  assert.equal(capturedCustomName, 'repo');
  assert.equal(path.basename(capturedProjectPath), 'repo');
  assert.notEqual(completePayload, null);
  const resolvedCompletePayload = completePayload as unknown as {
    project: Record<string, unknown>;
    message: string;
  };
  assert.equal(resolvedCompletePayload.message, 'Repository cloned successfully');
  assert.equal((resolvedCompletePayload.project.projectId as string) || '', 'project-1');
});

test('startCloneProject keeps GitHub tokens out of git URL and progress output', async () => {
  const gitProcess = createMockGitProcess();
  const token = 'ghp-test-token-value';
  const progressMessages: string[] = [];
  let capturedCloneUrl = '';
  let capturedToken: string | null | undefined;

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/private-repo.git',
      newGithubToken: token,
      userId: 1,
    },
    {
      onProgress: (message) => progressMessages.push(message),
      onComplete: () => undefined,
    },
    buildDependencies({
      spawnGitClone: (cloneUrl, _clonePath, githubToken) => {
        capturedCloneUrl = cloneUrl;
        capturedToken = githubToken;
        return gitProcess as any;
      },
    }),
  );

  const stderrLine =
    `fatal: unable to access 'https://${token}@github.com/example/private-repo.git': denied\n`;
  const splitAt = stderrLine.indexOf(token) + Math.floor(token.length / 2);
  gitProcess.stderr.write(stderrLine.slice(0, splitAt));
  gitProcess.stderr.write(stderrLine.slice(splitAt));
  const basicCredential = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  const basicDiagnostic = `Authorization: Basic ${basicCredential}\n`;
  const basicSplitAt = basicDiagnostic.indexOf(basicCredential) + Math.floor(basicCredential.length / 2);
  gitProcess.stderr.write(basicDiagnostic.slice(0, basicSplitAt));
  gitProcess.stderr.write(basicDiagnostic.slice(basicSplitAt));
  gitProcess.emit('close', 1);

  await assert.rejects(operation.waitForCompletion, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'GIT_CLONE_FAILED');
    assert.equal(error.message.includes(token), false);
    return true;
  });

  assert.equal(capturedCloneUrl, 'https://github.com/example/private-repo.git');
  assert.equal(capturedToken, token);
  assert.ok(progressMessages.some((message) => message.includes('***')));
  assert.equal(progressMessages.some((message) => message.includes(token)), false);
  assert.equal(progressMessages.some((message) => message.includes(basicCredential)), false);
});

test('startCloneProject rejects embedded repository URL credentials', async () => {
  for (const githubUrl of [
    'https://embedded-user:embedded-password@github.com/example/repo.git',
    'ssh://embedded-token@github.com/example/repo.git',
    'git://embedded-token@github.com/example/repo.git',
    'embedded-token@github.com:example/repo.git',
    'opaque:embedded-token@github.com/example/repo.git',
  ]) {
    await assert.rejects(
      () => startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl,
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'CLONE_URL_CREDENTIALS_NOT_ALLOWED');
        assert.equal(error.message.includes('embedded-password'), false);
        assert.equal(error.message.includes('embedded-token'), false);
        return true;
      },
    );
  }
});

test('startCloneProject rejects repository URL query strings and fragments before spawning', async () => {
  let spawnCalls = 0;
  for (const githubUrl of [
    'https://github.com/example/repo.git?access_token=query-secret',
    'https://github.com/example/repo.git#fragment-secret',
    'ssh://git@github.com/example/repo.git?token=query-secret',
  ]) {
    await assert.rejects(
      () => startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl,
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies({
          spawnGitClone: () => {
            spawnCalls += 1;
            throw new Error('Git must not run for a URL query or fragment');
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'CLONE_URL_CREDENTIALS_NOT_ALLOWED');
        assert.equal(error.message.includes('query-secret'), false);
        assert.equal(error.message.includes('fragment-secret'), false);
        return true;
      },
    );
  }

  assert.equal(spawnCalls, 0);
});

test('startCloneProject redacts credential query values in Git diagnostics without a request token', async () => {
  const gitProcess = createMockGitProcess();
  const querySecret = 'query-only-secret';
  const progressMessages: string[] = [];

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/private-repo.git',
      userId: 1,
    },
    {
      onProgress: (message) => progressMessages.push(message),
      onComplete: () => undefined,
    },
    buildDependencies({
      spawnGitClone: () => gitProcess as any,
    }),
  );

  gitProcess.stderr.write(
    `fatal: unable to access 'https://github.com/example/private-repo.git?access_token=${querySecret}'\n`,
  );
  gitProcess.emit('close', 1);

  await assert.rejects(operation.waitForCompletion, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.message.includes(querySecret), false);
    return true;
  });
  assert.equal(progressMessages.some((message) => message.includes(querySecret)), false);
});

test('startCloneProject does not forward a GitHub token to non-GitHub remotes', async () => {
  const gitProcess = createMockGitProcess();
  const token = 'ghp-non-github-must-not-forward';
  let capturedToken: string | null | undefined;

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://example.invalid/private-repo.git',
      newGithubToken: token,
      userId: 1,
    },
    {
      onProgress: () => undefined,
      onComplete: () => undefined,
    },
    buildDependencies({
      spawnGitClone: (_cloneUrl, _clonePath, githubToken) => {
        capturedToken = githubToken;
        return gitProcess as any;
      },
    }),
  );

  gitProcess.emit('close', 1);
  await assert.rejects(operation.waitForCompletion);
  assert.equal(capturedToken, null);
});

test('startCloneProject does not spawn after the caller disconnects during validation', async () => {
  let resolveValidation: (result: { valid: boolean; resolvedPath?: string }) => void = () => {
    throw new Error('Validation promise resolver was not initialized');
  };
  let requestClosed = false;
  let spawnCalls = 0;
  const validation = new Promise<{ valid: boolean; resolvedPath?: string }>((resolve) => {
    resolveValidation = resolve;
  });

  const operationPromise = startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      userId: 1,
    },
    {
      onProgress: () => undefined,
      onComplete: () => undefined,
      isCancelled: () => requestClosed,
    },
    buildDependencies({
      validatePath: () => validation,
      spawnGitClone: () => {
        spawnCalls += 1;
        throw new Error('Git must not start after disconnect');
      },
    }),
  );

  requestClosed = true;
  resolveValidation({ valid: true, resolvedPath: '/workspace/root' });
  const operation = await operationPromise;
  await operation.waitForCompletion;
  assert.equal(spawnCalls, 0);
});
