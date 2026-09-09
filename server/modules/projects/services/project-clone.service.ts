import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { githubTokensDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import type { WorkspacePathValidationResult } from '@/shared/types.js';
import { AppError, validateWorkspacePath } from '@/shared/utils.js';

type CloneProjectInput = {
  workspacePath: string;
  githubUrl: string;
  githubTokenId?: number | null;
  newGithubToken?: string | null;
  userId: number | string;
};

type CloneCompletePayload = {
  project: Record<string, unknown>;
  message: string;
};

type CloneProjectEventHandlers = {
  onProgress: (message: string) => void;
  onComplete: (payload: CloneCompletePayload) => void;
  /** Returns true when the streaming caller disconnected before Git started. */
  isCancelled?: () => boolean;
};

type GitCloneProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
  kill(): void;
};

type CloneProjectDependencies = {
  validatePath: (requestedPath: string) => Promise<WorkspacePathValidationResult>;
  ensureDirectory: (directoryPath: string) => Promise<void>;
  pathExists: (targetPath: string) => Promise<boolean>;
  removePath: (targetPath: string) => Promise<void>;
  getGithubTokenById: (
    tokenId: number,
    userId: number,
  ) => Promise<{ github_token: string } | null>;
  /**
   * Starts Git with the repository URL kept credential-free.  The optional
   * token is supplied out-of-band through the child environment so it never
   * appears in argv (and therefore cannot leak through process listings).
   */
  spawnGitClone: (
    cloneUrl: string,
    clonePath: string,
    githubToken?: string | null,
  ) => GitCloneProcess;
  registerProject: (projectPath: string, customName: string) => Promise<{ project: Record<string, unknown> }>;
  logError: (message: string, error: unknown) => void;
};

export type CloneProjectOperation = {
  waitForCompletion: Promise<void>;
  cancel: () => void;
};

const cancelledCloneOperation = (): CloneProjectOperation => ({
  waitForCompletion: Promise.resolve(),
  cancel: () => undefined,
});

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function sanitizeGitError(message: string, token: string | null): string {
  if (!message) {
    return message;
  }

  let sanitized = message;

  // Git occasionally echoes the credential-bearing remote in progress or
  // authentication errors.  Redact both the literal token and the common
  // URL/base64 representations before anything reaches SSE or logs.
  if (token) {
    const candidates = [token];
    try {
      candidates.push(encodeURIComponent(token));
    } catch {
      // A malformed surrogate is not a valid URI component; the literal
      // token is still redacted below.
    }
    try {
      candidates.push(encodeURI(token));
    } catch {
      // Keep the literal and component-encoded candidates above.
    }
    try {
      candidates.push(decodeURIComponent(token));
    } catch {
      // A token is not required to be URI-encoded; an invalid escape sequence
      // simply has no decoded representation to redact.
    }
    for (const candidate of new Set(candidates.filter(Boolean))) {
      const escapedToken = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(escapedToken, 'g'), '***');
    }

    try {
      // Git may render Basic auth as base64. Cover the helper's
      // `x-access-token:<token>` form as well as the common empty/user-token
      // permutations seen in curl/Git diagnostics.
      for (const credential of [
        `${token}:`,
        `:${token}`,
        `x-access-token:${token}`,
        `${token}:x`,
        `x:${token}`,
      ]) {
        const basicCredential = Buffer.from(credential, 'utf8').toString('base64');
        if (basicCredential) {
          const escapedBasicCredential = basicCredential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          sanitized = sanitized.replace(new RegExp(escapedBasicCredential, 'g'), '***');
        }
      }
    } catch {
      // Buffer encoding should not fail for a string, but keep redaction
      // fail-safe if a test/runtime supplies an unusual string-like value.
    }
  }

  // Defense in depth for credentials supplied in the URL itself (including a
  // caller that bypasses the normal token fields).  Keep the host/path so the
  // Git diagnostic remains useful without exposing the auth segment.
  return sanitized.replace(
    /([a-z][a-z\d+.-]*:\/\/)([^\s/@]+(?::[^\s/@]*)?@)/gi,
    '$1***@',
  ).replace(
    /([?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|key|password|passwd|secret|signature|sig|token)=)[^&#\s]*/gi,
    '$1***',
  ).replace(
    /(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/gi,
    '$1***',
  );
}

function resolveCloneFailureMessage(lastError: string, sanitizedError: string): string {
  if (lastError.includes('Authentication failed') || lastError.includes('could not read Username')) {
    return 'Authentication failed. Please check your credentials.';
  }

  if (lastError.includes('Repository not found')) {
    return 'Repository not found. Please check the URL and ensure you have access.';
  }

  if (lastError.includes('already exists')) {
    return 'Directory already exists';
  }

  if (sanitizedError) {
    return sanitizedError;
  }

  return 'Git clone failed';
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unexpected error';
}

/**
 * Return a clone URL that is safe to pass to `git` as an argument.  Tokens
 * supplied through the request must be delivered by the credential helper,
 * never as URL user-info (which is visible in argv and Git diagnostics).
 * Reject embedded HTTP(S) credentials instead of silently changing the
 * requested remote; callers should use `githubTokenId`/`newGithubToken`.
 */
function normalizeCredentialFreeCloneUrl(repositoryUrl: string): string {
  if (/[\u0000-\u001f\u007f]/.test(repositoryUrl)) {
    throw new AppError('Invalid githubUrl', {
      code: 'INVALID_GITHUB_URL',
      statusCode: 400,
    });
  }

  try {
    const parsed = new URL(repositoryUrl);
    const protocol = parsed.protocol.toLowerCase();
    // Query strings and fragments are not part of a repository clone URL for
    // any parsed transport (HTTP(S), SSH, Git, etc.). Reject them before the
    // protocol-specific credential checks so an arbitrary remote cannot carry
    // a token in Git argv either.
    if (parsed.search || parsed.hash) {
      throw new AppError('Repository URL must not contain query strings or fragments.', {
        code: 'CLONE_URL_CREDENTIALS_NOT_ALLOWED',
        statusCode: 400,
      });
    }

    // Opaque/unknown URL schemes can leave an `@` in the path instead of
    // populating URL.username. Treat that shape as userinfo unless it is the
    // explicitly allowed SSH `git` username below; this prevents a token-like
    // `user@host` value from bypassing the WHATWG URL fields.
    if (!parsed.username && repositoryUrl.includes('@')) {
      throw new AppError(
        'Repository URL must not contain embedded credentials. Use a GitHub token field instead.',
        {
          code: 'CLONE_URL_CREDENTIALS_NOT_ALLOWED',
          statusCode: 400,
        },
      );
    }

    let decodedUsername = parsed.username;
    try {
      decodedUsername = decodeURIComponent(parsed.username);
    } catch {
      // Keep the encoded value; it will fail the allow-list below.
    }

    const isSshTransport = protocol === 'ssh:' || protocol === 'git+ssh:';
    if (parsed.password || (parsed.username && (!isSshTransport || decodedUsername !== 'git'))) {
      throw new AppError(
        'Repository URL must not contain embedded credentials. Use a GitHub token field instead.',
        {
          code: 'CLONE_URL_CREDENTIALS_NOT_ALLOWED',
          statusCode: 400,
        },
      );
    }

    if (protocol === 'http:' || protocol === 'https:') {
      // URL#toString() gives us a canonical, credential-free argument.
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    // SCP-like SSH URLs (`git@host:org/repo.git`) are valid Git arguments but
    // are not accepted by WHATWG URL. Only the conventional `git` username is
    // allowed; arbitrary userinfo could itself be a bearer token.
    if (/[?#]/.test(repositoryUrl)) {
      throw new AppError('Repository URL must not contain query strings or fragments.', {
        code: 'CLONE_URL_CREDENTIALS_NOT_ALLOWED',
        statusCode: 400,
      });
    }
    const scpMatch = /^([^@\s/:]+)@([^:\s]+):/.exec(repositoryUrl);
    const scpUser = scpMatch?.[1];
    if ((scpUser && scpUser !== 'git') || (repositoryUrl.includes('@') && !scpMatch)) {
      throw new AppError(
        'Repository URL must not contain embedded credentials. Use a GitHub token field instead.',
        {
          code: 'CLONE_URL_CREDENTIALS_NOT_ALLOWED',
          statusCode: 400,
        },
      );
    }
  }

  return repositoryUrl;
}

type GitOutputConsumer = {
  push: (data: Buffer | string) => void;
  flush: () => void;
};

/**
 * Redact Git output at line boundaries rather than per `data` chunk. Git can
 * split a credential-bearing URL across chunks; sanitizing each chunk alone
 * would let the token escape in two separate progress events. Holding the
 * incomplete line until its newline (or process close) closes that gap while
 * retaining normal clone progress updates (`\r`-delimited by Git).
 */
function createGitOutputConsumer(
  token: string | null,
  onMessage: (message: string) => void,
): GitOutputConsumer {
  let pending = '';
  let flushed = false;

  const emitCompleteLines = (): void => {
    if (flushed) {
      return;
    }

    const pieces = pending.split(/[\r\n]/);
    pending = pieces.pop() || '';

    for (const piece of pieces) {
      const message = sanitizeGitError(piece.trim(), token);
      if (message) {
        onMessage(message);
      }
    }
  };

  return {
    push: (data) => {
      if (flushed) {
        return;
      }
      pending += data.toString();
      emitCompleteLines();
    },
    flush: () => {
      if (flushed) {
        return;
      }
      // Split first so all complete lines are emitted, then sanitize the
      // remaining unterminated fragment as one whole value.
      const pieces = pending.split(/[\r\n]/);
      pending = pieces.pop() || '';
      for (const piece of pieces) {
        const message = sanitizeGitError(piece.trim(), token);
        if (message) {
          onMessage(message);
        }
      }
      const finalMessage = sanitizeGitError(pending.trim(), token);
      pending = '';
      flushed = true;
      if (finalMessage) {
        onMessage(finalMessage);
      }
    },
  };
}

/**
 * Derive the checkout directory from a repository URL without allowing URL
 * syntax to become a filesystem path.  `git clone` receives the full URL, but
 * the local target is always expected to be one fresh child of the validated
 * workspace directory.  In particular, a URL ending in `/.` or `/..` must
 * never turn the clone target into the workspace itself (or its parent).
 */
function resolveCloneTargetPath(workspacePath: string, repositoryUrl: string): {
  repositoryName: string;
  clonePath: string;
} {
  const sanitizedUrl = repositoryUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const repositoryName = sanitizedUrl.split('/').pop() || 'repository';

  // Backslashes are separators on Windows and are not valid repository names
  // on the supported Git hosting providers. Reject them explicitly so a
  // Windows deployment cannot reinterpret an otherwise harmless POSIX string
  // as a nested/absolute target.
  if (
    !repositoryName
    || repositoryName === '.'
    || repositoryName === '..'
    || repositoryName.includes('\\')
    || repositoryName.includes('\0')
    || /[\x00-\x1f]/.test(repositoryName)
  ) {
    throw new AppError('Invalid repository name in githubUrl', {
      code: 'INVALID_CLONE_TARGET',
      statusCode: 400,
    });
  }

  const workspaceRoot = path.resolve(workspacePath);
  const clonePath = path.resolve(workspaceRoot, repositoryName);
  const relativeTarget = path.relative(workspaceRoot, clonePath);
  const targetEscapesWorkspace = !relativeTarget
    || relativeTarget === '..'
    || relativeTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTarget);
  if (targetEscapesWorkspace) {
    throw new AppError('Clone target must be a new directory directly under the workspace path', {
      code: 'INVALID_CLONE_TARGET',
      statusCode: 400,
    });
  }

  return { repositoryName, clonePath };
}

/**
 * Never send a GitHub token to an arbitrary clone host. The project wizard is
 * a GitHub workflow; SSH/non-GitHub remotes must rely on their own credential
 * mechanism rather than turning this service into a bearer-token forwarder.
 */
function canUseGithubToken(repositoryUrl: string): boolean {
  try {
    const parsed = new URL(repositoryUrl);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
}

const defaultDependencies: CloneProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureDirectory: async (directoryPath: string): Promise<void> => {
    await mkdir(directoryPath, { recursive: true });
  },
  pathExists: defaultPathExists,
  removePath: async (targetPath: string): Promise<void> => {
    await rm(targetPath, { recursive: true, force: true });
  },
  getGithubTokenById: async (
    tokenId: number,
    userId: number,
  ): Promise<{ github_token: string } | null> => {
    const tokenRow = githubTokensDb.getGithubTokenById(userId, tokenId) as
      | { github_token: string }
      | null;
    return tokenRow;
  },
  spawnGitClone: (
    cloneUrl: string,
    clonePath: string,
    githubToken?: string | null,
  ): GitCloneProcess => {
    // Keep the remote URL credential-free. Git's environment-backed config
    // helper supplies the token only to the child process, avoiding argv,
    // shell history, reverse-proxy logs, and Git's own remote diagnostics.
    const gitBaseEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      // Server operators may enable Git tracing globally. A credentialed clone
      // must not inherit trace switches that can print HTTP auth material, and
      // applying the same safe baseline to public clones keeps behavior stable.
      GIT_TRACE: '0',
      GIT_TRACE_CURL: '0',
      GIT_CURL_VERBOSE: '0',
      GIT_TRACE_PACKET: '0',
      GIT_TRACE2: '0',
      GIT_TRACE2_EVENT: '0',
      GIT_TRACE2_PERF: '0',
      GIT_TRACE_REDACT: '1',
      GIT_TRACE_CURL_NO_DATA: '1',
    };
    const gitEnvironment: NodeJS.ProcessEnv = githubToken
      ? {
        ...gitBaseEnvironment,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$CLOUDCLI_GITHUB_TOKEN"; }; f',
        CLOUDCLI_GITHUB_TOKEN: githubToken,
      }
      : gitBaseEnvironment;

    return spawn('git', ['clone', '--progress', '--', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnvironment,
    }) as unknown as GitCloneProcess;
  },
  registerProject: async (
    projectPath: string,
    customName: string,
  ): Promise<{ project: Record<string, unknown> }> =>
    createProject({
      projectPath,
      customName,
    }) as Promise<{ project: Record<string, unknown> }>,
  logError: (message: string, error: unknown): void => {
    console.error(message, error);
  },
};

export async function startCloneProject(
  input: CloneProjectInput,
  handlers: CloneProjectEventHandlers,
  dependencies: CloneProjectDependencies = defaultDependencies,
): Promise<CloneProjectOperation> {
  const isCancelled = () => handlers.isCancelled?.() === true;
  // A request can close while one of the validation/token lookups below is
  // awaiting I/O. Return a no-op operation in that case so no filesystem or
  // Git side effect is started after the caller has gone away.
  if (isCancelled()) {
    return cancelledCloneOperation();
  }

  const normalizedWorkspacePath = input.workspacePath.trim();
  const normalizedGithubUrl = input.githubUrl.trim();

  if (!normalizedWorkspacePath) {
    throw new AppError('workspacePath and githubUrl are required', {
      code: 'WORKSPACE_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  if (!normalizedGithubUrl) {
    throw new AppError('workspacePath and githubUrl are required', {
      code: 'GITHUB_URL_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalizedGithubUrl.startsWith('-')) {
    throw new AppError('Invalid githubUrl', {
      code: 'INVALID_GITHUB_URL',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedWorkspacePath);
  if (isCancelled()) {
    return cancelledCloneOperation();
  }
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError(pathValidation.error || 'Invalid workspace path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
    });
  }

  const absolutePath = pathValidation.resolvedPath;
  await dependencies.ensureDirectory(absolutePath);
  if (isCancelled()) {
    return cancelledCloneOperation();
  }

  let githubToken: string | null = null;
  if (typeof input.githubTokenId === 'number') {
    const numericUserId =
      typeof input.userId === 'number' ? input.userId : Number.parseInt(String(input.userId), 10);
    if (Number.isNaN(numericUserId)) {
      throw new AppError('Authenticated user is required', {
        code: 'AUTHENTICATION_REQUIRED',
        statusCode: 401,
      });
    }

    const token = await dependencies.getGithubTokenById(input.githubTokenId, numericUserId);
    if (isCancelled()) {
      return cancelledCloneOperation();
    }
    if (!token) {
      throw new AppError('GitHub token not found', {
        code: 'GITHUB_TOKEN_NOT_FOUND',
        statusCode: 404,
      });
    }

    githubToken = token.github_token;
  } else if (input.newGithubToken && input.newGithubToken.trim().length > 0) {
    githubToken = input.newGithubToken.trim();
  }

  if (githubToken && /[\u0000-\u001f\u007f]/.test(githubToken)) {
    throw new AppError('Invalid GitHub token', {
      code: 'INVALID_GITHUB_TOKEN',
      statusCode: 400,
    });
  }

  // Validate the derived child name before URL normalization; `/..` must not
  // become the host root and hide an unsafe clone target.
  resolveCloneTargetPath(absolutePath, normalizedGithubUrl);
  const cloneUrl = normalizeCredentialFreeCloneUrl(normalizedGithubUrl);
  if (isCancelled()) {
    return cancelledCloneOperation();
  }
  const { repositoryName: repoName, clonePath } = resolveCloneTargetPath(
    absolutePath,
    cloneUrl,
  );

  if (await dependencies.pathExists(clonePath)) {
    throw new AppError(
      `Directory "${repoName}" already exists. Please choose a different location or remove the existing directory.`,
      {
        code: 'CLONE_TARGET_ALREADY_EXISTS',
        statusCode: 409,
      },
    );
  }

  if (isCancelled()) {
    return cancelledCloneOperation();
  }

  // Never interpolate a GitHub token into the remote URL. Besides exposing it
  // to process listings, Git may echo the URL in stderr; credentials are
  // passed to the child through the environment-backed helper above instead.
  const cloneToken = githubToken && canUseGithubToken(cloneUrl) ? githubToken : null;

  handlers.onProgress(`Cloning into '${repoName}'...`);
  // `onProgress` is synchronous in the route, so this check closes the final
  // gap between the last async validation and spawning the child process.
  if (isCancelled()) {
    return cancelledCloneOperation();
  }
  const gitProcess = dependencies.spawnGitClone(cloneUrl, clonePath, cloneToken);
  let lastError = '';

  const stdoutConsumer = createGitOutputConsumer(githubToken, (message) => {
    handlers.onProgress(message);
  });
  const stderrConsumer = createGitOutputConsumer(githubToken, (message) => {
    // Keep enough context for authentication/repository classification, but
    // never retain an unbounded Git transcript in memory.
    lastError = `${lastError}\n${message}`.trim().slice(-16_384);
    handlers.onProgress(message);
  });

  gitProcess.stdout?.on('data', (data: Buffer | string) => {
    stdoutConsumer.push(data);
  });

  gitProcess.stderr?.on('data', (data: Buffer | string) => {
    stderrConsumer.push(data);
  });

  const waitForCompletion = new Promise<void>((resolve, reject) => {
    gitProcess.on('close', async (code) => {
      // Streams normally end before `close`, but flushing here also covers
      // mocked processes and abrupt failures without releasing a final
      // unterminated (possibly credential-bearing) fragment.
      stdoutConsumer.flush();
      stderrConsumer.flush();

      if (code === 0) {
        try {
          const createdProject = await dependencies.registerProject(clonePath, repoName);
          handlers.onComplete({
            project: createdProject.project,
            message: 'Repository cloned successfully',
          });
          resolve();
        } catch (error) {
          reject(
            new AppError(
              `Clone succeeded but failed to add project: ${sanitizeGitError(resolveErrorMessage(error), githubToken)}`,
              {
                code: 'CLONE_PROJECT_REGISTRATION_FAILED',
                statusCode: 500,
              },
            ),
          );
        }
        return;
      }

      const sanitizedError = sanitizeGitError(lastError, githubToken);
      const errorMessage = resolveCloneFailureMessage(sanitizedError, sanitizedError);

      try {
        await dependencies.removePath(clonePath);
      } catch (cleanupError) {
        dependencies.logError('Failed to clean up after clone failure:', cleanupError);
      }

      reject(
        new AppError(errorMessage, {
          code: 'GIT_CLONE_FAILED',
          statusCode: 500,
        }),
      );
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(
          new AppError('Git is not installed or not in PATH', {
            code: 'GIT_NOT_FOUND',
            statusCode: 500,
          }),
        );
        return;
      }

      reject(
        new AppError(sanitizeGitError(error.message, githubToken), {
          code: 'GIT_EXECUTION_FAILED',
          statusCode: 500,
        }),
      );
    });
  });

  return {
    waitForCompletion,
    cancel: () => {
      gitProcess.kill();
    },
  };
}
