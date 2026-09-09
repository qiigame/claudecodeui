import { realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { forkSession as forkClaudeSession } from '@anthropic-ai/claude-agent-sdk';

import type { IProviderFork } from '@/shared/interfaces.js';
import {
  AppError,
  buildClaudeProjectDirectoryName,
  resolveClaudeConfigDirectory,
  type ProviderTranscriptPathValidationInput,
  validateProviderTranscriptPath,
} from '@/shared/utils.js';

import { withClaudeEnvironmentLock } from './claude-config-lock.js';

type ClaudeForkFunction = (
  providerSessionId: string,
  options: {
    dir: string;
    upToMessageId?: string;
    title?: string;
  },
) => Promise<{ sessionId?: unknown }>;

/**
 * Injectable seams for Claude fork storage and SDK calls. The provider tests
 * use these hooks to verify path validation and the serialized config-root
 * environment without invoking a real Claude account.
 */
export type ClaudeForkProviderDependencies = {
  getClaudeConfigDirectory: () => string;
  listTranscriptEntries: (directory: string) => Promise<readonly string[]>;
  validateTranscriptPath: (
    input: ProviderTranscriptPathValidationInput,
  ) => Promise<string | null>;
  forkSession: ClaudeForkFunction;
};

const defaultDependencies: ClaudeForkProviderDependencies = {
  getClaudeConfigDirectory: resolveClaudeConfigDirectory,
  listTranscriptEntries: (directory) => readdir(directory),
  validateTranscriptPath: validateProviderTranscriptPath,
  // The SDK's public return type has changed slightly across releases.  The
  // adapter only relies on the stable sessionId field, so keep the seam narrow
  // and validate the value at runtime below.
  forkSession: forkClaudeSession as unknown as ClaudeForkFunction,
};

const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the exact project directory the SDK will search for `dir`. */
function resolveClaudeProjectDirectory(
  configDirectory: string,
  projectPath: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  const encodedProjectDirectory = buildClaudeProjectDirectoryName(projectPath, environment);
  if (!encodedProjectDirectory) {
    return null;
  }

  try {
    // Resolve the full directory rather than comparing only its basename: a
    // nested attacker-controlled folder can reuse the same encoded name.
    return path.resolve(realpathSync(path.join(
      configDirectory,
      'projects',
      encodedProjectDirectory,
    )));
  } catch {
    return null;
  }
}

function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_SESSION_ID_PATTERN.test(value);
}

/**
 * A configured project-directory override changes the SDK's lookup key while
 * the transcript validator only sees the persisted path. Reject it rather
 * than guessing which directory the fork helper will select. The check is on
 * property presence (including an empty value) because the fork queue installs
 * a non-empty CLAUDE_CONFIG_DIR before calling the SDK, which activates the
 * SDK's override branch.
 */
function hasClaudeProjectDirectoryOverride(environment: NodeJS.ProcessEnv): boolean {
  return Object.prototype.hasOwnProperty.call(
    environment,
    'CLAUDE_CODE_PROJECT_DIR_NAME',
  );
}

async function withClaudeConfigDirectory<T>(
  configDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  // The SDK has no per-call environment argument. Hold the shared lock for
  // the complete SDK operation so normal Claude turns can capture a stable
  // environment snapshot instead of inheriting this temporary override.
  return withClaudeEnvironmentLock(async () => {
    const hadConfigDirectory = Object.prototype.hasOwnProperty.call(
      process.env,
      'CLAUDE_CONFIG_DIR',
    );
    const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = configDirectory;
      return await operation();
    } finally {
      if (hadConfigDirectory) {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
      } else {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    }
  });
}

function forkSourceError(): AppError {
  return new AppError('The Claude fork source transcript is invalid or unavailable.', {
    code: 'FORK_SOURCE_INVALID',
    statusCode: 409,
  });
}

function forkResultError(message: string): AppError {
  return new AppError(message, {
    code: 'FORK_FAILED',
    statusCode: 502,
  });
}

/**
 * Branches a Claude conversation by copying its transcript into a new session
 * file.
 *
 * The SDK owns this: it remaps every message uuid and rewrites the parentUuid
 * chain, which is what makes the copy resumable rather than just a duplicate
 * file. `upToMessageId` is inclusive of the row it names.
 */
export class ClaudeForkProvider implements IProviderFork {
  private readonly dependencies: ClaudeForkProviderDependencies;

  constructor(dependencyOverrides: Partial<ClaudeForkProviderDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides };
  }

  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    // `jsonl_path` is a database index, not a trusted SDK input.  Validate it
    // before deriving a directory or asking Claude to copy anything.  The
    // canonical result is used for every later path operation, so a symlink or
    // lexical `..` segment can never redirect the fork source.
    if (
      !input
      || typeof input.providerSessionId !== 'string'
      || typeof input.jsonlPath !== 'string'
      || typeof input.projectPath !== 'string'
      || !input.providerSessionId.trim()
      || !input.jsonlPath.trim()
      || !input.projectPath.trim()
      || !isClaudeSessionId(input.providerSessionId)
    ) {
      throw forkSourceError();
    }

    // The SDK's project lookup has a second, environment-driven directory
    // name.  Since the persisted transcript path does not record whether that
    // override was active when it was created, accepting it here could make us
    // validate one file and ask the SDK to fork another. Fail closed until a
    // caller supplies an explicit, authenticated mapping for that mode.
    let configDirectory: string;
    let projectsRoot: string;
    let environmentSnapshot: NodeJS.ProcessEnv;
    let canonicalSourcePath: string | null;
    try {
      // Resolve the configured root and the native project-key override while
      // holding the same lock used by the SDK call. Without this snapshot a
      // concurrent fork could make the default resolver observe the other
      // fork's temporary CLAUDE_CONFIG_DIR.
      const captured = await withClaudeEnvironmentLock(() => ({
        configDirectory: this.dependencies.getClaudeConfigDirectory(),
        environment: { ...process.env },
      }));
      configDirectory = captured.configDirectory;
      environmentSnapshot = captured.environment;
      if (hasClaudeProjectDirectoryOverride(environmentSnapshot)) {
        throw forkSourceError();
      }
      projectsRoot = path.join(configDirectory, 'projects');
      canonicalSourcePath = await this.dependencies.validateTranscriptPath({
        provider: 'claude',
        candidatePath: input.jsonlPath,
        rootPath: projectsRoot,
        providerSessionId: input.providerSessionId,
        expectedSubagent: false,
        environment: environmentSnapshot,
      });
    } catch {
      // Do not pass provider/config filesystem details through the API when a
      // custom validator or deployment configuration fails unexpectedly.
      throw forkSourceError();
    }
    if (
      !canonicalSourcePath
      || path.basename(canonicalSourcePath) !== `${input.providerSessionId}.jsonl`
    ) {
      throw forkSourceError();
    }

    const expectedProjectDirectory = resolveClaudeProjectDirectory(
      configDirectory,
      input.projectPath,
      environmentSnapshot,
    );
    if (
      !expectedProjectDirectory
      || path.resolve(path.dirname(canonicalSourcePath)) !== expectedProjectDirectory
    ) {
      // The SDK receives `projectPath`, not the already encoded transcript
      // directory. Requiring the exact native key prevents a stale or
      // cross-project database path from being forked under the wrong context.
      throw forkSourceError();
    }

    // The SDK returns only the new id, so capture the source directory's
    // transcript names before invoking it. A pre-existing valid `<id>.jsonl`
    // must not be mistaken for this fork if the SDK fails to write or reuses an
    // id. This is intentionally a preflight snapshot; an OS-level replacement
    // race with another writer remains outside this process-level guarantee.
    let preexistingTranscriptNames: ReadonlySet<string>;
    try {
      preexistingTranscriptNames = new Set(
        await this.dependencies.listTranscriptEntries(path.dirname(canonicalSourcePath)),
      );
    } catch {
      throw forkSourceError();
    }

    // `dir` is the session's working directory, which the SDK encodes into the
    // `~/.claude/projects/<encoded>` folder name itself — passing that folder
    // makes it encode an already-encoded path and find nothing.
    let result: { sessionId?: unknown };
    try {
      result = await withClaudeConfigDirectory(
        configDirectory,
        () => this.dependencies.forkSession(input.providerSessionId, {
          dir: input.projectPath,
          upToMessageId: input.upToAnchorId,
          title: input.title,
        }),
      );
    } catch {
      // SDK errors include absolute config/project paths. Keep the transport
      // error stable and intentionally omit those implementation details.
      throw forkResultError('Claude could not create the fork.');
    }
    const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : '';

    if (!isClaudeSessionId(sessionId)) {
      throw forkResultError('Claude did not return a session id for the fork.');
    }
    if (sessionId.toLowerCase() === input.providerSessionId.toLowerCase()) {
      throw forkResultError('Claude returned the source session id for the fork.');
    }

    if (preexistingTranscriptNames.has(`${sessionId}.jsonl`)) {
      throw forkResultError('Claude returned an existing session id for the fork.');
    }

    // Claude writes the branch beside the source transcript.  Derive that
    // location only from the already-canonical source path; never call
    // dirname() on the raw database value.  Validate the returned artifact's
    // native envelope too, rather than trusting a successful SDK response.
    const forkedCandidatePath = path.join(path.dirname(canonicalSourcePath), `${sessionId}.jsonl`);
    let canonicalForkedPath: string | null;
    try {
      canonicalForkedPath = await this.dependencies.validateTranscriptPath({
        provider: 'claude',
        candidatePath: forkedCandidatePath,
        rootPath: projectsRoot,
        providerSessionId: sessionId,
        expectedSubagent: false,
        environment: environmentSnapshot,
      });
    } catch {
      canonicalForkedPath = null;
    }
    if (
      !canonicalForkedPath
      || path.basename(canonicalForkedPath) !== `${sessionId}.jsonl`
    ) {
      throw forkResultError('Claude reported a fork but wrote no valid transcript for it.');
    }

    return { providerSessionId: sessionId, jsonlPath: canonicalForkedPath };
  }
}
