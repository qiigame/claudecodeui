import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ClaudeForkProvider,
  type ClaudeForkProviderDependencies,
} from '@/modules/providers/list/claude/claude-fork.provider.js';
import { captureClaudeEnvironmentSnapshot } from '@/modules/providers/list/claude/claude-config-lock.js';
import {
  buildClaudeProjectDirectoryName,
  buildClaudeTranscriptFilePath,
  validateProviderTranscriptPath,
} from '@/shared/utils.js';

type ForkInput = Parameters<ClaudeForkProvider['forkSession']>[0];
type CleanupContext = {
  after(callback: () => void | Promise<void>): void;
};

const SOURCE_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FORK_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_FORK_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hadOriginalProjectDirectoryOverride = Object.prototype.hasOwnProperty.call(
  process.env,
  'CLAUDE_CODE_PROJECT_DIR_NAME',
);
const originalProjectDirectoryOverride = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;

test.beforeEach(() => {
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
});

test.afterEach(() => {
  if (hadOriginalProjectDirectoryOverride) {
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = originalProjectDirectoryOverride;
  } else {
    delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  }
});

/** Independent fixture implementation of the SDK's project-key algorithm. */
function sdkProjectDirectoryName(projectPath: string): string {
  const encoded = path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) {
    return encoded;
  }
  let hash = 0;
  const resolved = path.resolve(projectPath);
  for (let index = 0; index < resolved.length; index += 1) {
    hash = (hash << 5) - hash + resolved.charCodeAt(index) | 0;
  }
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function createInput(
  configDirectory: string,
  providerSessionId: string,
  projectPath = '/workspace/project',
): ForkInput {
  return {
    providerSessionId,
    jsonlPath: path.join(
      configDirectory,
      'projects',
      sdkProjectDirectoryName(projectPath),
      `${providerSessionId}.jsonl`,
    ),
    projectPath,
  };
}

async function createConfigDirectory(
  testContext: CleanupContext,
  projectPaths: string[],
  sourceSessionIds: string[] = [SOURCE_SESSION_ID],
): Promise<string> {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-fork-'));
  testContext.after(() => rm(configDirectory, { recursive: true, force: true }));
  await mkdir(path.join(configDirectory, 'projects'), { recursive: true });
  await Promise.all(projectPaths.flatMap((projectPath) => {
    const projectDirectory = path.join(
      configDirectory,
      'projects',
      sdkProjectDirectoryName(projectPath),
    );
    return [
      mkdir(projectDirectory, { recursive: true }),
      ...sourceSessionIds.map(async (sourceSessionId) => {
        await mkdir(projectDirectory, { recursive: true });
        await writeFile(
          path.join(projectDirectory, `${sourceSessionId}.jsonl`),
          `${JSON.stringify({ sessionId: sourceSessionId, cwd: projectPath })}\n`,
          'utf8',
        );
      }),
    ];
  }));
  return configDirectory;
}

async function writeForkTranscriptIfNew(
  configDirectory: string,
  sourceSessionId: string,
  projectPath: string,
  result: { sessionId?: unknown },
): Promise<void> {
  const forkSessionId = result.sessionId;
  if (
    typeof forkSessionId !== 'string'
    || !CLAUDE_SESSION_ID_PATTERN.test(forkSessionId)
    || forkSessionId.toLowerCase() === sourceSessionId.toLowerCase()
  ) {
    return;
  }

  const forkPath = path.join(
    configDirectory,
    'projects',
    sdkProjectDirectoryName(projectPath),
    `${forkSessionId}.jsonl`,
  );
  try {
    await writeFile(
      forkPath,
      `${JSON.stringify({ sessionId: forkSessionId, cwd: projectPath })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

function createDependencies(
  configDirectory: string,
  forkSession: ClaudeForkProviderDependencies['forkSession'],
): ClaudeForkProviderDependencies {
  return {
    getClaudeConfigDirectory: () => configDirectory,
    listTranscriptEntries: async (directory) => readdir(directory),
    validateTranscriptPath: validateProviderTranscriptPath,
    forkSession: async (sourceSessionId, options) => {
      const result = await forkSession(sourceSessionId, options);
      await writeForkTranscriptIfNew(
        configDirectory,
        sourceSessionId,
        options.dir,
        result,
      );
      return result;
    },
  };
}

test('Claude fork uses the resolved config root and restores the process environment', async (t) => {
  const hadOriginal = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR');
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/operator/claude-config';

  try {
    const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
    let observedConfigDirectory: string | undefined;
    const provider = new ClaudeForkProvider(createDependencies(
      configDirectory,
      async () => {
        observedConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
        return { sessionId: FORK_SESSION_ID };
      },
    ));

    const result = await provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID));

    assert.equal(observedConfigDirectory, configDirectory);
    assert.equal(result.providerSessionId, FORK_SESSION_ID);
    assert.equal(
      result.jsonlPath,
      path.join(
        configDirectory,
        'projects',
        sdkProjectDirectoryName('/workspace/project'),
        `${FORK_SESSION_ID}.jsonl`,
      ),
    );
    assert.equal(process.env.CLAUDE_CONFIG_DIR, '/operator/claude-config');
  } finally {
    if (hadOriginal) {
      process.env.CLAUDE_CONFIG_DIR = original;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  }
});

test('concurrent Claude forks cannot observe one another\'s config directory', async (t) => {
  const hadOriginal = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR');
  const original = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;

  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstEntered: (() => void) | undefined;
  const firstEnteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });
  const observed: string[] = [];

  try {
    const firstConfigDirectory = await createConfigDirectory(t, ['/workspace/project']);
    const secondSourceSessionId = SOURCE_SESSION_ID.replace(/^1/, '4');
    const secondConfigDirectory = await createConfigDirectory(
      t,
      ['/workspace/project'],
      [secondSourceSessionId],
    );
    const firstProvider = new ClaudeForkProvider(createDependencies(
      firstConfigDirectory,
      async () => {
        observed.push(process.env.CLAUDE_CONFIG_DIR ?? '');
        firstEntered?.();
        await firstGate;
        return { sessionId: FORK_SESSION_ID };
      },
    ));
    const secondProvider = new ClaudeForkProvider(createDependencies(
      secondConfigDirectory,
      async () => {
        observed.push(process.env.CLAUDE_CONFIG_DIR ?? '');
        return { sessionId: SECOND_FORK_SESSION_ID };
      },
    ));

    const first = firstProvider.forkSession(createInput(firstConfigDirectory, SOURCE_SESSION_ID));
    await firstEnteredPromise;
    const second = secondProvider.forkSession(createInput(
      secondConfigDirectory,
      secondSourceSessionId,
    ));

    // The second SDK call must wait for the first call to restore its env.
    await Promise.resolve();
    assert.deepEqual(observed, [firstConfigDirectory]);

    releaseFirst!();
    await Promise.all([first, second]);
    assert.deepEqual(observed, [firstConfigDirectory, secondConfigDirectory]);
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR'), false);
  } finally {
    if (hadOriginal) {
      process.env.CLAUDE_CONFIG_DIR = original;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  }
});

test('a normal Claude environment snapshot waits for a fork override', async (t) => {
  const hadOriginal = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR');
  const original = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;

  let releaseFork: (() => void) | undefined;
  let forkEntered: (() => void) | undefined;
  const forkEnteredPromise = new Promise<void>((resolve) => { forkEntered = resolve; });
  const forkGate = new Promise<void>((resolve) => { releaseFork = resolve; });

  try {
    const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
    const provider = new ClaudeForkProvider(createDependencies(
      configDirectory,
      async () => {
        forkEntered?.();
        await forkGate;
        return { sessionId: FORK_SESSION_ID };
      },
    ));

    const fork = provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID));
    await forkEnteredPromise;

    let snapshotResolved = false;
    const snapshot = captureClaudeEnvironmentSnapshot().then((value) => {
      snapshotResolved = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(snapshotResolved, false);

    releaseFork?.();
    await fork;
    const captured = await snapshot;
    assert.equal(captured.CLAUDE_CONFIG_DIR, undefined);
  } finally {
    releaseFork?.();
    if (hadOriginal) {
      process.env.CLAUDE_CONFIG_DIR = original;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  }
});

test('Claude fork rejects empty or malformed source ids before invoking the SDK', async (t) => {
  let invoked = false;
  const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
  const provider = new ClaudeForkProvider(createDependencies(
    configDirectory,
    async () => {
      invoked = true;
      return { sessionId: FORK_SESSION_ID };
    },
  ));

  for (const sourceId of ['', 'source-session']) {
    await assert.rejects(
      provider.forkSession(createInput(configDirectory, sourceId)),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'FORK_SOURCE_INVALID'
        && 'statusCode' in error
        && error.statusCode === 409
      ),
    );
  }
  assert.equal(invoked, false);
});

test('Claude fork rejects a transcript from a different encoded project directory', async (t) => {
  let invoked = false;
  const configDirectory = await createConfigDirectory(t, ['/workspace/project', '/workspace/other-project']);
  const provider = new ClaudeForkProvider(createDependencies(
    configDirectory,
    async () => {
      invoked = true;
      return { sessionId: FORK_SESSION_ID };
    },
  ));
  const input = createInput(configDirectory, SOURCE_SESSION_ID);
  input.jsonlPath = path.join(
    configDirectory,
    'projects',
    sdkProjectDirectoryName('/workspace/other-project'),
    `${SOURCE_SESSION_ID}.jsonl`,
  );

  await assert.rejects(
    provider.forkSession(input),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORK_SOURCE_INVALID',
  );
  assert.equal(invoked, false);
});

test('Claude fork does not accept a nested path that only reuses the project key basename', async (t) => {
  const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
  const nestedDirectory = path.join(
    configDirectory,
    'projects',
    'untrusted-wrapper',
    sdkProjectDirectoryName('/workspace/project'),
  );
  await mkdir(nestedDirectory, { recursive: true });
  const provider = new ClaudeForkProvider(createDependencies(
    configDirectory,
    async () => ({ sessionId: FORK_SESSION_ID }),
  ));
  const input = createInput(configDirectory, SOURCE_SESSION_ID);
  input.jsonlPath = path.join(nestedDirectory, `${SOURCE_SESSION_ID}.jsonl`);

  await assert.rejects(
    provider.forkSession(input),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORK_SOURCE_INVALID',
  );
});

test('Claude fork reproduces the SDK long project-key hash', async (t) => {
  const longProjectPath = `/workspace/${'a'.repeat(220)}`;
  const configDirectory = await createConfigDirectory(t, [longProjectPath]);
  const provider = new ClaudeForkProvider(createDependencies(
    configDirectory,
    async () => ({ sessionId: FORK_SESSION_ID }),
  ));

  const result = await provider.forkSession(
    createInput(configDirectory, SOURCE_SESSION_ID, longProjectPath),
  );

  assert.equal(
    result.jsonlPath,
    path.join(
      configDirectory,
      'projects',
      sdkProjectDirectoryName(longProjectPath),
      `${FORK_SESSION_ID}.jsonl`,
    ),
  );
  assert.equal(sdkProjectDirectoryName(longProjectPath).length > 200, true);
});

test('shared Claude transcript paths follow SDK length and override rules', async (t) => {
  const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
  const environment = { CLAUDE_CONFIG_DIR: configDirectory };
  const longProjectPath = `/workspace/${'a'.repeat(220)}`;
  const expectedLongKey = `-workspace-${'a'.repeat(189)}-j0cmqf`;

  assert.equal(
    buildClaudeProjectDirectoryName('/workspace/project', environment),
    '-workspace-project',
  );
  assert.equal(
    buildClaudeProjectDirectoryName(longProjectPath, environment),
    expectedLongKey,
  );
  assert.equal(
    buildClaudeTranscriptFilePath(
      configDirectory,
      '/workspace/project',
      SOURCE_SESSION_ID,
      environment,
    ),
    path.join(configDirectory, 'projects', '-workspace-project', `${SOURCE_SESSION_ID}.jsonl`),
  );
  assert.equal(
    buildClaudeTranscriptFilePath(
      configDirectory,
      '/workspace/project',
      SOURCE_SESSION_ID,
      { ...environment, CLAUDE_CODE_PROJECT_DIR_NAME: 'explicit-project' },
    ),
    path.join(configDirectory, 'projects', 'explicit-project', `${SOURCE_SESSION_ID}.jsonl`),
  );
  assert.equal(
    buildClaudeTranscriptFilePath(
      configDirectory,
      '/workspace/project',
      SOURCE_SESSION_ID,
      {
        CLAUDE_CONFIG_DIR: '/ambient/operator-config',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'explicit-project',
      },
    ),
    path.join(configDirectory, 'projects', 'explicit-project', `${SOURCE_SESSION_ID}.jsonl`),
  );
  assert.equal(
    buildClaudeProjectDirectoryName('/workspace/project', {
      ...environment,
      CLAUDE_CODE_PROJECT_DIR_NAME: 'not/a-safe-key',
    }),
    null,
  );
});

test('Claude fork rejects an invalid or source-matching result id', async (t) => {
  const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
  for (const returnedId of ['', 'not-a-uuid', SOURCE_SESSION_ID]) {
    const provider = new ClaudeForkProvider(createDependencies(
      configDirectory,
      async () => ({ sessionId: returnedId }),
    ));

    await assert.rejects(
      provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID)),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORK_FAILED',
    );
  }
});

test('Claude fork rejects a result id that existed before the SDK call', async (t) => {
  const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
  const existingForkPath = path.join(
    configDirectory,
    'projects',
    sdkProjectDirectoryName('/workspace/project'),
    `${FORK_SESSION_ID}.jsonl`,
  );
  await writeFile(existingForkPath, '{}\n', 'utf8');
  let invoked = false;
  const provider = new ClaudeForkProvider(createDependencies(
    configDirectory,
    async () => {
      invoked = true;
      return { sessionId: FORK_SESSION_ID };
    },
  ));

  await assert.rejects(
    provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID)),
    (error: unknown) => (
      error instanceof Error
      && error.message === 'Claude returned an existing session id for the fork.'
      && 'code' in error
      && error.code === 'FORK_FAILED'
      && 'statusCode' in error
      && error.statusCode === 502
    ),
  );
  assert.equal(invoked, true);
});

test('Claude SDK failures are controlled and restore the environment', async (t) => {
  const hadOriginal = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR');
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/operator/claude-config';

  try {
    const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
    const provider = new ClaudeForkProvider(createDependencies(
      configDirectory,
      async () => {
        throw new Error('/secret/operator/path should not escape');
      },
    ));

    await assert.rejects(
      provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID)),
      (error: unknown) => (
        error instanceof Error
        && error.message === 'Claude could not create the fork.'
        && 'code' in error
        && error.code === 'FORK_FAILED'
        && 'statusCode' in error
        && error.statusCode === 502
      ),
    );
    assert.equal(process.env.CLAUDE_CONFIG_DIR, '/operator/claude-config');
  } finally {
    if (hadOriginal) {
      process.env.CLAUDE_CONFIG_DIR = original;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  }
});

test('Claude fork fails when the SDK artifact is missing or malformed', async (t) => {
  await t.test('missing artifact', async (missingTest) => {
    const configDirectory = await createConfigDirectory(missingTest, ['/workspace/project']);
    const provider = new ClaudeForkProvider({
      getClaudeConfigDirectory: () => configDirectory,
      listTranscriptEntries: async (directory) => readdir(directory),
      validateTranscriptPath: validateProviderTranscriptPath,
      // Deliberately return an id without creating the file. The provider must
      // not turn the SDK response into a database row for a nonexistent file.
      forkSession: async () => ({ sessionId: FORK_SESSION_ID }),
    });

    await assert.rejects(
      provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID)),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORK_FAILED',
    );
  });

  await t.test('malformed artifact', async (malformedTest) => {
    const configDirectory = await createConfigDirectory(malformedTest, ['/workspace/project']);
    const provider = new ClaudeForkProvider({
      getClaudeConfigDirectory: () => configDirectory,
      listTranscriptEntries: async (directory) => readdir(directory),
      validateTranscriptPath: validateProviderTranscriptPath,
      forkSession: async (_sourceSessionId, options) => {
        await writeFile(
          path.join(
            configDirectory,
            'projects',
            sdkProjectDirectoryName(options.dir),
            `${FORK_SESSION_ID}.jsonl`,
          ),
          `${JSON.stringify({ sessionId: SOURCE_SESSION_ID, cwd: '/workspace/other-project' })}\n`,
          'utf8',
        );
        return { sessionId: FORK_SESSION_ID };
      },
    });

    await assert.rejects(
      provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID)),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORK_FAILED',
    );
  });
});

test('Claude fork refuses an active project-directory override', async (t) => {
  const hadOverride = Object.prototype.hasOwnProperty.call(
    process.env,
    'CLAUDE_CODE_PROJECT_DIR_NAME',
  );
  const originalOverride = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'operator-project';

  try {
    const configDirectory = await createConfigDirectory(t, ['/workspace/project']);
    const provider = new ClaudeForkProvider(createDependencies(
      configDirectory,
      async () => ({ sessionId: FORK_SESSION_ID }),
    ));
    await assert.rejects(
      provider.forkSession(createInput(configDirectory, SOURCE_SESSION_ID)),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORK_SOURCE_INVALID',
    );
  } finally {
    if (hadOverride) {
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME = originalOverride;
    } else {
      delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    }
  }
});
