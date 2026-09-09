import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

import {
  AppError,
  closeProviderTranscriptReadHandle,
  openProviderTranscriptReadHandle,
  preflightProviderTranscriptPath,
  readFirstJsonlRecordFromHandle,
  readObjectRecord,
  resolveCodexHomeDirectory,
  validateProviderTranscriptRecord,
} from '@/shared/utils.js';

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * Codex ships two entry points and they expose different things. The
 * `@openai/codex-sdk` this app runs conversations through is a wrapper around
 * `codex exec`, and its whole surface is `startThread` and `resumeThread` —
 * there is no way to branch a thread or to resume one partway. The same
 * binary's `app-server` subcommand speaks JSON-RPC and does have that
 * primitive, `thread/fork`, which is what the Codex IDE clients build their
 * own "fork" and "edit an earlier message" on top of.
 *
 * So this is a second transport to the same CLI, opened only for the
 * operations the SDK cannot express. Everything else still goes through the
 * SDK.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
export type CodexThreadFork = {
  threadId: string;
  /** Canonical, validated path under the configured Codex sessions root. */
  path: string;
};

function forkSourceError(): AppError {
  return new AppError('The Codex fork source transcript is invalid or unavailable.', {
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
 * Resolves an existing directory to the same canonical spelling used by the
 * transcript validator.  A fork must never silently turn a missing or regular
 * file `cwd` into a path relative to the CloudCLI process.
 */
async function resolveCanonicalDirectory(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    return null;
  }

  const lexicalPath = path.resolve(value);
  try {
    if (!(await stat(lexicalPath)).isDirectory()) {
      return null;
    }
    return path.resolve(await realpath(lexicalPath));
  } catch {
    return null;
  }
}

/**
 * Authenticates a Codex rollout artifact before it is used as a fork source or
 * persisted as the new session path.  The shared preflight establishes root
 * containment, filename shape, symlink policy, and regular-file type; the
 * opening envelope then binds the native id, top-level thread kind, and cwd.
 */
async function validateCodexThreadArtifact(input: {
  candidatePath: string;
  threadId: string;
  sessionsRoot: string;
  expectedCwd: string;
}): Promise<string | null> {
  const preflight = await preflightProviderTranscriptPath({
    provider: 'codex',
    candidatePath: input.candidatePath,
    rootPath: input.sessionsRoot,
    providerSessionId: input.threadId,
  });
  if (!preflight) {
    return null;
  }

  const opened = await openProviderTranscriptReadHandle(preflight.canonicalPath, {
    device: preflight.device,
    inode: preflight.inode,
  });
  if (!opened) {
    return null;
  }
  try {
    const firstRecord = await readFirstJsonlRecordFromHandle(opened.handle);
    if (!validateProviderTranscriptRecord({
      provider: 'codex',
      preflight,
      firstRecord,
      providerSessionId: input.threadId,
      expectedSubagent: false,
    })) {
      return null;
    }

    const record = readObjectRecord(firstRecord);
    const payload = readObjectRecord(record?.payload);
    if (record?.type !== 'session_meta' || typeof payload?.cwd !== 'string') {
      return null;
    }

    const artifactCwd = await resolveCanonicalDirectory(payload.cwd);
    return artifactCwd === input.expectedCwd
      ? preflight.canonicalPath
      : null;
  } finally {
    await closeProviderTranscriptReadHandle(opened.handle);
  }
}

/**
 * Resolves the `codex` launcher shipped in node_modules.
 *
 * Deliberately not the `codex` on PATH: a machine can have a second, older
 * install, and the protocol this speaks is only guaranteed against the
 * version this package depends on.
 */
function resolveCodexLauncher(): string {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new AppError('The Codex CLI package is not installed, so Codex conversations cannot be branched.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
}

/**
 * Runs one exchange against a freshly spawned `codex app-server`.
 *
 * A process per operation rather than a pooled long-lived one: the handshake
 * costs a fraction of a second, forking happens at most once per user action,
 * and a shared child would need lifecycle handling — restarts, back-pressure,
 * a crash taking every pending fork with it — for no measurable gain next to
 * the model turn that follows.
 */
async function withAppServer<T>(
  run: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
  codexHomeDirectory = resolveCodexHomeDirectory(),
): Promise<T> {
  const launcher = resolveCodexLauncher();
  // `resolveCodexHomeDirectory` also accepts CloudCLI's COMIC_CODEX_HOME
  // alias, while the native CLI only reads CODEX_HOME.  Normalize the child
  // environment so the app-server talks to the exact sessions tree that was
  // authenticated by the caller, rather than the operator's ambient home.
  const childEnvironment = {
    ...process.env,
    CODEX_HOME: codexHomeDirectory,
  };
  const child = spawn(process.execPath, [launcher, 'app-server'], {
    env: childEnvironment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  let nextRequestId = 1;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let exitReason: string | null = null;

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Server-to-client notifications and any non-JSON banner are not
      // replies to anything this client asked for.
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const failPending = (reason: string) => {
    exitReason = reason;
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
  };

  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    failPending(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });
  // A child that dies mid-request leaves its pipes broken, and the next write
  // raises EPIPE on the stream rather than at the call site. Without a
  // listener that is an unhandled 'error' event, which takes the whole server
  // down over one failed fork.
  child.stdin?.on('error', (error) => failPending(error.message));
  child.stdout?.on('error', (error) => failPending(error.message));
  child.stderr?.on('error', () => {});

  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new AppError(response.error.message || `Codex app-server rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
            details: { method, rpcCode: response.error.code },
          }));
          return;
        }
        resolve(response.result);
      });

      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    // `capabilities` is deliberately empty. `thread/fork` with `lastTurnId` is
    // in the stable protocol; only `beforeTurnId` and the turn-listing methods
    // are gated behind `experimentalApi`, and neither is needed here.
    await call('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: {},
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    return await run(call);
  } catch (error) {
    if (error instanceof AppError && exitReason) {
      throw new AppError(`${error.message}${stderr ? ` — ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`, {
        code: error.code,
        statusCode: error.statusCode,
      });
    }
    throw error;
  } finally {
    reader.close();
    child.kill();
  }
}

export const codexAppServer = {
  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from. `jsonlPath` is the persisted source index and
   * is authenticated before the app-server is allowed to copy anything.  The
   * protocol also accepts the canonical `path`; sending it is important because
   * otherwise the app-server resolves only `threadId` again and can select a
   * different rollout after the preflight check.
   */
  async forkThread(input: {
    threadId: string;
    jsonlPath: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    if (
      !input
      || typeof input.threadId !== 'string'
      || typeof input.jsonlPath !== 'string'
      || typeof input.cwd !== 'string'
      || !input.threadId.trim()
      || !input.jsonlPath.trim()
      || !input.cwd.trim()
    ) {
      throw forkSourceError();
    }

    const codexHomeDirectory = resolveCodexHomeDirectory();
    const sessionsRoot = path.join(codexHomeDirectory, 'sessions');
    const expectedCwd = await resolveCanonicalDirectory(input.cwd);
    if (!expectedCwd) {
      throw forkSourceError();
    }

    // Authenticate the source before spawning a child or issuing the RPC. The
    // database path is an index only; a successful `thread/fork` response does
    // not make an arbitrary host file a valid Codex transcript.
    let canonicalSourcePath: string | null;
    try {
      canonicalSourcePath = await validateCodexThreadArtifact({
        candidatePath: input.jsonlPath,
        threadId: input.threadId,
        sessionsRoot,
        expectedCwd,
      });
    } catch {
      canonicalSourcePath = null;
    }
    if (!canonicalSourcePath) {
      throw forkSourceError();
    }

    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
        threadId: input.threadId,
        // Codex's app-server protocol documents `path` as an alternative
        // source selector. Keep threadId for compatibility with older servers,
        // while making the authenticated canonical artifact authoritative when
        // this server supports the field.
        path: canonicalSourcePath,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(expectedCwd ? { cwd: expectedCwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const reportedPath = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !reportedPath) {
        throw forkResultError('Codex reported a fork without a thread id or transcript path.');
      }
      if (threadId.toLowerCase() === input.threadId.toLowerCase()) {
        throw forkResultError('Codex returned the source thread id for the fork.');
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file. Validate the returned path and opening
      // envelope, not just its existence, so an app-server bug or a malicious
      // response cannot move the row outside the configured Codex home.
      let canonicalForkPath: string | null;
      try {
        canonicalForkPath = await validateCodexThreadArtifact({
          candidatePath: reportedPath,
          threadId,
          sessionsRoot,
          expectedCwd,
        });
      } catch {
        canonicalForkPath = null;
      }
      if (!canonicalForkPath) {
        throw forkResultError('Codex reported a fork but wrote no valid transcript for it.');
      }

      return { threadId, path: canonicalForkPath };
    }, codexHomeDirectory);
  },
};
