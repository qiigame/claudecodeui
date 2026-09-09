import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';
import { AppError } from '@/shared/utils.js';

import { createAgentRouter } from '../agent.routes.js';

type AgentDependencies = Parameters<typeof createAgentRouter>[0];

function createDependencies(
  overrides: Partial<AgentDependencies> = {},
): AgentDependencies {
  const unexpectedProviderCall = async (): Promise<never> => {
    throw new Error('Provider runtime should not be called');
  };

  return {
    fileSystem: {} as AgentDependencies['fileSystem'],
    crypto: nodeCrypto,
    homeDirectory: () => '/home/test',
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      AgentDependencies['spawnProcess'],
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    githubTokens: { getActiveGithubToken: () => null },
    projects: { createProjectPath: () => ({ outcome: 'created' }) },
    models: {} as AgentDependencies['models'],
    queryClaude: unexpectedProviderCall as AgentDependencies['queryClaude'],
    queryCursor: unexpectedProviderCall as AgentDependencies['queryCursor'],
    queryCodex: unexpectedProviderCall as AgentDependencies['queryCodex'],
    queryOpenCode: unexpectedProviderCall as AgentDependencies['queryOpenCode'],
    GithubClient: class {} as unknown as AgentDependencies['GithubClient'],
    ...overrides,
  };
}

async function withAgentServer(
  dependencies: AgentDependencies,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(dependencies));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(error instanceof AppError ? error.statusCode : 500).json({
      error: error instanceof Error ? error.message : 'failed',
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Agent route rejects missing project input before invoking provider dependencies', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Inspect this project', stream: false }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Either githubUrl or projectPath is required');
  });
});

test('Agent route validates API keys through the injected repository', async () => {
  const receivedKeys: string[] = [];
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: {
      validateApiKey: (apiKey) => {
        receivedKeys.push(apiKey);
        return undefined;
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'invalid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run' }),
    });
    assert.equal(response.status, 401);
  });

  assert.deepEqual(receivedKeys, ['invalid-key']);
});

test('platform presentation flag cannot bypass credentials when a deployment policy is supplied', async () => {
  let firstUserLookups = 0;
  await withAgentServer(createDependencies({
    // This simulates a stale VITE_IS_PLATFORM=true build flag. The explicit
    // auth-policy switch is false, so the legacy first-user fallback must not
    // run even though the old dependency field says platform mode.
    platformMode: true,
    allowUnauthenticatedPlatform: false,
    deploymentPolicy: {
      profile: 'developer',
      capabilities: {
        'agent.use': true,
      },
    },
    users: {
      getFirstUser: () => {
        firstUserLookups += 1;
        return { id: 1, username: 'unexpected-first-user' };
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run', stream: false }),
    });
    assert.equal(response.status, 401);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'API key required');
  });
  assert.equal(firstUserLookups, 0);
});

test('DingTalk-required developer profiles enforce a verified actor on Agent API keys', async () => {
  let identityChecks = 0;
  let providerCalls = 0;
  await withAgentServer(createDependencies({
    platformMode: false,
    deploymentPolicy: {
      profile: 'developer',
      capabilities: { 'agent.use': true },
    },
    requireVerifiedActor: true,
    apiKeys: { validateApiKey: () => ({ id: 7, username: '待登记' }) },
    assertActorCanWrite: (userId) => {
      identityChecks += 1;
      assert.equal(userId, 7);
      throw new AppError('Your project identity is pending registration.', {
        code: 'IDENTITY_ENROLLMENT_REQUIRED',
        statusCode: 403,
      });
    },
    queryClaude: (async () => {
      providerCalls += 1;
    }) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'valid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run', stream: false }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 403);
    assert.equal(body.error, 'Your project identity is pending registration.');
  });
  assert.equal(identityChecks, 1);
  assert.equal(providerCalls, 0);
});

test('managed Agent composition fails closed when the actor adapter is missing', async () => {
  let providerCalls = 0;
  await withAgentServer(createDependencies({
    platformMode: false,
    deploymentPolicy: {
      profile: 'developer',
      capabilities: { 'agent.use': true },
    },
    // This models an explicit SSO composition that accidentally omitted the
    // collaboration adapter. The router must reject before project/provider
    // work instead of silently treating the API key as a trusted actor.
    requireVerifiedActor: true,
    apiKeys: { validateApiKey: () => ({ id: 7, username: 'sso-user' }) },
    queryClaude: (async () => {
      providerCalls += 1;
    }) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'valid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run', stream: false }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 403);
    assert.equal(body.error, 'A registered project identity is required for Agent execution.');
  });
  assert.equal(providerCalls, 0);
});

test('legacy platform mode without DingTalk does not require an actor callback', async () => {
  let identityChecks = 0;
  let firstUserLookups = 0;
  await withAgentServer(createDependencies({
    platformMode: false,
    allowUnauthenticatedPlatform: true,
    deploymentPolicy: {
      profile: 'platform',
      capabilities: { 'agent.use': true },
    },
    requireVerifiedActor: false,
    users: {
      getFirstUser: () => {
        firstUserLookups += 1;
        return { id: 1, username: 'platform-user' };
      },
    },
    assertActorCanWrite: () => {
      identityChecks += 1;
      throw new Error('platform mode without SSO must not require actor');
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Run', stream: false }),
    });
    // The request reaches payload validation after authenticating the first
    // user, proving the actor callback was not used as an accidental gate.
    assert.equal(response.status, 400);
  });
  assert.equal(firstUserLookups, 1);
  assert.equal(identityChecks, 0);
});

test('explicit legacy platform auth switch may use the first user', async () => {
  let firstUserLookups = 0;
  await withAgentServer(createDependencies({
    platformMode: false,
    allowUnauthenticatedPlatform: true,
    deploymentPolicy: {
      profile: 'developer',
      capabilities: {
        'agent.use': true,
      },
    },
    users: {
      getFirstUser: () => {
        firstUserLookups += 1;
        return { id: 1, username: 'legacy-platform-user' };
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Run', stream: false }),
    });
    // The request reaches normal payload validation after the explicit
    // platform principal is attached; this proves auth did not demand a key.
    assert.equal(response.status, 400);
  });
  assert.equal(firstUserLookups, 1);
});

test('Agent route rejects a pending API-key actor before provider execution', async () => {
  let identityChecks = 0;
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: { validateApiKey: () => ({ id: 7, username: '待登记' }) },
    assertActorCanWrite: (userId) => {
      identityChecks += 1;
      assert.equal(userId, 7);
      throw new AppError('Your project identity is pending registration.', {
        code: 'IDENTITY_ENROLLMENT_REQUIRED',
        statusCode: 403,
      });
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'valid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run', stream: false }),
    });
    const body = await response.json() as { error: string };
    assert.equal(response.status, 403);
    assert.equal(body.error, 'Your project identity is pending registration.');
  });
  assert.equal(identityChecks, 1);
});

test('Agent route passes execution attribution to the provider runtime', async () => {
  let beginCalls = 0;
  let completeCalls = 0;
  let receivedEnvironment: Record<string, string> | undefined;
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: { validateApiKey: () => ({ id: 7, username: '已登记' }) },
    assertActorCanWrite: () => undefined,
    executionAttribution: {
      beginExecution: (input) => {
        beginCalls += 1;
        assert.equal(input.userId, 7);
        assert.equal(input.provider, 'claude');
        return { runId: 'run-agent-1', environment: { CLOUDCLI_PERSON_ID: 'alice' } };
      },
      completeExecution: (runId, status) => {
        completeCalls += 1;
        assert.equal(runId, 'run-agent-1');
        assert.equal(status, 'succeeded');
      },
    },
    fileSystem: { access: async () => undefined } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async () => ({ models: { DEFAULT: 'default-model' } }),
    } as unknown as AgentDependencies['models'],
    queryClaude: (async (_command, options) => {
      receivedEnvironment = options.executionEnvironment;
    }) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'valid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run', stream: false }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(beginCalls, 1);
  assert.equal(completeCalls, 1);
  assert.deepEqual(receivedEnvironment, { CLOUDCLI_PERSON_ID: 'alice' });
});

test('read-only deployment rejects Agent execution before API-key or provider work', async () => {
  let apiKeyValidationCalls = 0;
  let providerCalls = 0;
  await withAgentServer(createDependencies({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
    platformMode: false,
    apiKeys: {
      validateApiKey: () => {
        apiKeyValidationCalls += 1;
        throw new Error('API-key validation must not run after deployment denial');
      },
    },
    queryClaude: (async () => {
      providerCalls += 1;
      throw new Error('Provider must not run after deployment denial');
    }) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'invalid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run', stream: false }),
    });
    assert.equal(response.status, 403);
  });

  assert.equal(apiKeyValidationCalls, 0);
  assert.equal(providerCalls, 0);
});

test('Agent route rejects GitHub lookalike hosts before cloning', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com.evil.example/owner/repo',
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Invalid GitHub URL');
  });
});

test('GitHub cloning keeps credentials out of arguments and remote URL', async () => {
  const token = 'secret-token';
  let cloneArgs: readonly string[] = [];
  let cloneEnvironment: NodeJS.ProcessEnv | undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      mkdir: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    githubTokens: { getActiveGithubToken: () => token },
    spawnProcess: ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      cloneArgs = args;
      cloneEnvironment = options.env;
      process.nextTick(() => child.emit('error', new Error('expected test failure')));
      return child;
    }) as unknown as AgentDependencies['spawnProcess'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        message: 'Run',
        stream: false,
      }),
    });
    assert.equal(response.status, 500);
  });

  assert.deepEqual(cloneArgs.slice(0, 5), [
    'clone', '--depth', '1', '--', 'https://github.com/owner/repo.git',
  ]);
  assert.equal(cloneArgs.length, 6);
  assert.equal(cloneArgs.join(' ').includes(token), false);
  assert.equal(cloneEnvironment?.CLOUDCLI_GITHUB_TOKEN, token);
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(cloneEnvironment?.GIT_CONFIG_VALUE_0, '');
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_1, 'credential.helper');
});

test('Agent clone rejects credential-bearing query strings before spawning Git', async () => {
  const token = 'query-secret-token';
  let spawnCalls = 0;

  await withAgentServer(createDependencies({
    githubTokens: { getActiveGithubToken: () => token },
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('Git must not run for a credential-bearing URL');
    }) as unknown as AgentDependencies['spawnProcess'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: `https://github.com/owner/repo.git?token=${encodeURIComponent(token)}`,
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 500);
    assert.equal(body.includes(token), false);
    assert.equal(body.includes('Invalid GitHub URL'), true);
  });

  assert.equal(spawnCalls, 0);
});

test('Agent clone redacts Git credentials from SSE errors', async () => {
  const token = 'stderr-secret-token';
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      mkdir: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    githubTokens: { getActiveGithubToken: () => token },
    spawnProcess: (() => {
      process.nextTick(() => {
        // Deliberately split the credential across stream chunks; sanitizing
        // only each chunk would still leak the full token through diagnostics.
        child.stderr.write(`fatal: Authorization: Bearer ${token.slice(0, 7)}`);
        child.stderr.write(`${token.slice(7)}\n`);
        child.stderr.end();
        child.emit('close', 1);
      });
      return child;
    }) as unknown as AgentDependencies['spawnProcess'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        message: 'Run',
        stream: true,
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body.includes(token), false);
    assert.equal(body.includes('[REDACTED]'), true);
  });
});

test('Agent route reuses a matching checkout without cloning or deleting it', async () => {
  const spawnedArguments: string[][] = [];
  const removedPaths: string[] = [];
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      // Git remotes may include a trailing slash after the `.git` suffix;
      // normalization should still identify this as the requested checkout.
      child.stdout.end('https://github.com/owner/repo.git/\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
      rm: async (targetPath: string) => { removedPaths.push(targetPath); },
    } as unknown as AgentDependencies['fileSystem'],
    spawnProcess,
    models: {
      getProviderModels: async () => ({ models: { DEFAULT: 'default-model' } }),
    } as unknown as AgentDependencies['models'],
    queryClaude: (async () => undefined) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        projectPath: '/home/test/.claude/external-projects/existing',
        message: 'Run',
        stream: false,
        cleanup: true,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(spawnedArguments, [['config', '--get', 'remote.origin.url']]);
  assert.deepEqual(removedPaths, []);
});

test('Agent clone does not overwrite an existing checkout with a different remote', async () => {
  const spawnedArguments: string[][] = [];
  let mkdirCalls = 0;
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end('https://github.com/other/repo.git\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];

  await withAgentServer(createDependencies({
    fileSystem: {
      // The destination exists, so cloneGitHubRepo must validate its remote
      // and reject before attempting mkdir or a second `git clone`.
      access: async () => undefined,
      mkdir: async () => { mkdirCalls += 1; },
    } as unknown as AgentDependencies['fileSystem'],
    spawnProcess,
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        projectPath: '/home/test/.claude/external-projects/existing',
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.match(body.error, /different repository/);
  });

  assert.deepEqual(spawnedArguments, [['config', '--get', 'remote.origin.url']]);
  assert.equal(mkdirCalls, 0);
});

test('Agent branch workflow rejects a lookalike GitHub remote before Git writes', async () => {
  const spawnedArguments: string[][] = [];
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end('https://github.com.evil.example/owner/repo.git\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    spawnProcess,
    githubTokens: { getActiveGithubToken: () => 'test-token' },
    models: {
      getProviderModels: async () => ({ models: { DEFAULT: 'default-model' } }),
    } as unknown as AgentDependencies['models'],
    queryClaude: (async () => undefined) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/workspace/project',
        message: 'Run',
        createPR: true,
        stream: false,
      }),
    });
    const body = await response.json() as {
      branch?: { error?: string };
      pullRequest?: { error?: string };
    };

    // Branch/PR failures are reported as part of the successful agent result,
    // but no checkout or push process may run for a lookalike remote.
    assert.equal(response.status, 200);
    assert.match(body.branch?.error ?? '', /Invalid GitHub URL format/);
    assert.match(body.pullRequest?.error ?? '', /Invalid GitHub URL format/);
  });

  assert.deepEqual(spawnedArguments, [['config', '--get', 'remote.origin.url']]);
});
