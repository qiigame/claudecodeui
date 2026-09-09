import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import {
  captureDeploymentPolicy,
  isDeploymentReadOnly,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import type { AnyRecord } from '@/shared/types.js';
import {
  closeProviderTranscriptReadHandle,
  AppError,
  buildClaudeTranscriptFilePath,
  getOpenCodeDatabasePath,
  openProviderTranscriptReadHandle,
  openValidatedProviderTranscript,
  resolveClaudeConfigDirectory,
  resolveCodexHomeDirectory,
  type AuthenticatedProviderTranscript,
  type ProviderTranscriptPathValidationInput,
} from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type FileTail = {
  content: string;
  /** True when `content` is the whole file, not just its trailing bytes. */
  isComplete: boolean;
};

/**
 * A transcript that has passed the provider/root/envelope checks. Every caller
 * keeps the authenticated descriptor open through the usage read.
 */
type ResolvedTranscript = {
  canonicalPath: string;
  handle: FileHandle;
};

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  /** Startup-resolved deployment policy used by direct service callers. */
  deploymentPolicy?: DeploymentPolicy;
  getHomeDirectory: () => string;
  /** Optional per-provider roots; omitted values derive from getHomeDirectory and env. */
  getCodexHomeDirectory?: () => string;
  getClaudeConfigDirectory?: () => string;
  getOpenCodeDatabasePath: () => string;
  /**
   * Test-only seam for synthetic transcript fixtures. It must return an
   * already-authenticated, open descriptor; production uses the strict shared
   * opener and never accepts a path-only validator.
   */
  openAuthenticatedTranscriptForTest?: (
    input: ProviderTranscriptPathValidationInput,
  ) => Promise<AuthenticatedProviderTranscript | null>;
  fileExists: (filePath: string) => boolean;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
  readTextFileTail: (filePath: string, maxBytes: number) => Promise<FileTail>;
  getClaudeContextWindow: () => string | undefined;
  isProviderSessionSuperseded: (providerSessionId: string, provider: string) => boolean;
};

type TokenUsageResult = {
  used: number;
  total?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/**
 * Both JSONL usage readers below only need the newest usage row, which sits at
 * or near the end of the transcript. Reading just this much of the tail keeps
 * a session-open usage lookup O(1) in the transcript's size; the rare tail
 * with no usage row at all falls back to the full read.
 */
const TOKEN_USAGE_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Cursor and OpenCode token counters are read from provider-owned ambient
 * stores. Product/QA read-only deployments must not expose those stores to a
 * service account, even when an app session row already has a native id.
 */
function assertProviderTokenUsageAllowed(
  provider: string,
  deploymentPolicy: DeploymentPolicy,
): void {
  if (
    isDeploymentReadOnly(deploymentPolicy)
    && (provider === 'cursor' || provider === 'opencode')
  ) {
    throw new AppError(
      `Provider "${provider}" token usage is not available in the read-only deployment.`,
      {
        code: 'PROVIDER_READ_ONLY_UNSUPPORTED',
        statusCode: 403,
        details: { provider },
      },
    );
  }
}

/** Keeps a factory's fallback policy stable even if its source object is later mutated. */
function snapshotDeploymentPolicy(policy: DeploymentPolicy): DeploymentPolicy {
  return Object.freeze({
    profile: policy.profile,
    capabilities: Object.freeze({ ...policy.capabilities }),
  });
}

/** Reads a complete transcript from an already-authenticated descriptor. */
async function readTextFileFromHandle(handle: FileHandle): Promise<string> {
  return handle.readFile({ encoding: 'utf8' });
}

/**
 * Reads the newest tail from an already-authenticated descriptor. Keeping this
 * operation descriptor-backed is important: validation and parsing must not be
 * separated by a second path-based open that could observe a replacement file.
 */
async function readTextFileTailFromHandle(handle: FileHandle, maxBytes: number): Promise<FileTail> {
  const { size } = await handle.stat();
  if (size <= maxBytes) {
    return { content: await readTextFileFromHandle(handle), isComplete: true };
  }

  const buffer = Buffer.alloc(maxBytes);
  await handle.read(buffer, 0, maxBytes, size - maxBytes);
  const content = buffer.toString('utf8');
  // The window almost never starts on a row boundary; dropping everything up
  // to the first newline also discards any split multi-byte character.
  const firstNewline = content.indexOf('\n');
  return {
    content: firstNewline === -1 ? '' : content.slice(firstNewline + 1),
    isComplete: false,
  };
}

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: async (filePath) => {
    const opened = await openProviderTranscriptReadHandle(filePath);
    if (!opened) {
      throw new Error('Transcript file could not be opened for reading.');
    }
    try {
      return await readTextFileFromHandle(opened.handle);
    } finally {
      await closeProviderTranscriptReadHandle(opened.handle);
    }
  },
  readTextFileTail: async (filePath, maxBytes) => {
    const opened = await openProviderTranscriptReadHandle(filePath);
    if (!opened) {
      throw new Error('Transcript file could not be opened for reading.');
    }
    const handle = opened.handle;
    try {
      return await readTextFileTailFromHandle(handle, maxBytes);
    } finally {
      await closeProviderTranscriptReadHandle(handle);
    }
  },
  getClaudeContextWindow: () => process.env.CONTEXT_WINDOW,
  isProviderSessionSuperseded: (providerSessionId, provider) =>
    sessionsDb.isProviderSessionSuperseded(providerSessionId, provider),
};

function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
  resolveCandidate: (candidatePath: string) => Promise<ResolvedTranscript | null>,
): Promise<ResolvedTranscript | null> {
  let entries: Dirent[];
  try {
    entries = await dependencies.readDirectory(directoryPath);
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(
        entryPath,
        providerSessionId,
        dependencies,
        resolveCandidate,
      );
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      const resolved = await resolveCandidate(entryPath);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

/** Newest `token_count` snapshot in the given JSONL text, or null when it has none. */
function findCodexTokenUsage(fileContent: string): TokenUsageResult | null {
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (!tokenInfo) {
        continue;
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      if (tokenInfo.total_token_usage) {
        inputTokens = readUsageNumber(tokenInfo.total_token_usage.input_tokens);
        outputTokens = readUsageNumber(tokenInfo.total_token_usage.output_tokens);
        totalTokens = readUsageNumber(tokenInfo.total_token_usage.total_tokens)
          || inputTokens + outputTokens;
      }
      return {
        used: totalTokens,
        total: readUsageNumber(tokenInfo.model_context_window) || 200_000,
        inputTokens,
        outputTokens,
        breakdown: { input: inputTokens, output: outputTokens },
      };
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return null;
}

function emptyCodexTokenUsage(): TokenUsageResult {
  return {
    used: 0,
    total: 200_000,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}

/**
 * Usage reported for an app-created session before its provider has announced
 * a native session id.  In particular, callers must not use the app id as a
 * filename/database key: it is unrelated to provider storage and may collide
 * with another rollout.
 */
function emptyPendingSessionTokenUsage(): TokenUsageResult {
  return {
    used: 0,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}

/**
 * Latest context-window usage from a Claude transcript's already-parsed rows.
 *
 * Exported because the session-messages reader hands the same usage back on
 * every history page, the way the Codex and OpenCode readers do. Without that,
 * a Claude session's counter only moved when the session was reselected, and
 * the store's "this provider reports no usage" path overwrote it with zero.
 *
 * Reads the newest assistant turn only: `input_tokens + cache_read +
 * cache_creation` is that one request's whole prompt, i.e. what the context
 * window currently holds. Summing turns would count the same cached prefix
 * once per turn.
 */
export function summarizeClaudeTokenUsage(
  entries: AnyRecord[],
  configuredContextWindow: string | undefined = process.env.CONTEXT_WINDOW,
): TokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // A subagent's turns report the subagent's context window, not this
    // conversation's; reading one makes the counter drop to the subagent's
    // number and bounce back on the next main-thread turn.
    if (entry?.isSidechain === true) {
      continue;
    }

    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) {
      continue;
    }

    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
    const rowCacheReadTokens = readUsageNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
    );
    const rowCacheCreationTokens = readUsageNumber(
      usage.cache_creation_input_tokens
        ?? usage.cacheCreationInputTokens
        ?? usage.cacheCreationTokens,
    );
    const rowInputTokens = directInputTokens + rowCacheReadTokens + rowCacheCreationTokens;
    const rowOutputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

    // `<synthetic>` rows — interrupts, API errors, "No response requested" —
    // are written with an all-zero usage block rather than none at all. They
    // never carried a prompt, so treating one as the newest turn zeroed a
    // counter that a live event had just set correctly.
    if (rowInputTokens === 0 && rowOutputTokens === 0) {
      continue;
    }

    cacheReadTokens = rowCacheReadTokens;
    cacheCreationTokens = rowCacheCreationTokens;
    inputTokens = rowInputTokens;
    outputTokens = rowOutputTokens;
    break;
  }

  const parsedContextWindow = Number.parseInt(configuredContextWindow ?? '', 10);
  const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160_000;
  const cacheTokens = cacheReadTokens + cacheCreationTokens;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

function parseClaudeUsageEntries(fileContent: string): AnyRecord[] {
  const entries: AnyRecord[] = [];
  for (const line of fileContent.trim().split('\n')) {
    try {
      entries.push(JSON.parse(line) as AnyRecord);
    } catch {
      // Skip malformed lines without discarding usage from earlier messages.
    }
  }
  return entries;
}

function claudeEntriesHaveUsage(entries: AnyRecord[]): boolean {
  return entries.some((entry) => entry?.type === 'assistant' && entry.message?.usage);
}

function readOpenCodeTokenUsage(databasePath: string, providerSessionId: string): TokenUsageResult {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];

    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        unsupported: true,
        message: 'Token usage tracking is not available in this OpenCode database schema',
      };
    }

    const row = database.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(providerSessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      throw new AppError('OpenCode session was not found.', {
        code: 'OPENCODE_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
    const outputTokens = readUsageNumber(row.outputTokens);
    const used = readUsageNumber(row.inputTokens)
      + outputTokens
      + readUsageNumber(row.reasoningTokens)
      + readUsageNumber(row.cacheReadTokens)
      + readUsageNumber(row.cacheWriteTokens);

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  } finally {
    database.close();
  }
}

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  // Capture deployment configuration once when this service is constructed.
  // HTTP callers may supply the composition-root snapshot per call, while
  // direct/embedded callers use this immutable startup fallback rather than
  // re-reading mutable process.env for every token-usage request.
  const startupDeploymentPolicy = snapshotDeploymentPolicy(
    captureDeploymentPolicy(dependencies.deploymentPolicy),
  );
  // Keep the legacy getHomeDirectory injection used by the provider tests and
  // self-hosted integrations, while honoring CODEX_HOME/CLAUDE_CONFIG_DIR in
  // production. The closures are intentionally evaluated per request so a
  // long-lived process never retains a stale environment path.
  const hasInjectedHomeDirectory = typeof dependencyOverrides.getHomeDirectory === 'function';
  const getCodexHomeDirectory = dependencies.getCodexHomeDirectory
    ?? (() => hasInjectedHomeDirectory
      // A caller that injects a synthetic home (normally a unit test) expects
      // the old `<home>/.codex` behavior and must not accidentally inherit a
      // developer's ambient CODEX_HOME.
      ? path.join(dependencies.getHomeDirectory(), '.codex')
      : resolveCodexHomeDirectory());
  const getClaudeConfigDirectory = dependencies.getClaudeConfigDirectory
    ?? (() => hasInjectedHomeDirectory
      ? path.join(dependencies.getHomeDirectory(), '.claude')
      : resolveClaudeConfigDirectory());
  // A string-returning validator is intentionally unsupported: validation and
  // path-based reopening would reintroduce a TOCTOU boundary. The sole test
  // override owns an open descriptor for the complete read lifecycle.
  const openAuthenticatedTranscript = dependencies.openAuthenticatedTranscriptForTest
    ?? openValidatedProviderTranscript;
  return {
    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(
      sessionId: string,
      deploymentPolicy?: DeploymentPolicy,
    ): Promise<TokenUsageResult> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      assertProviderTokenUsageAllowed(
        session.provider,
        deploymentPolicy ?? startupDeploymentPolicy,
      );

      if (session.provider === 'cursor') {
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking not available for Cursor sessions',
        };
      }

      // A freshly-created app row has no provider-native id until the first
      // run announces one. Do not fall back to `sessionId`: app ids are not
      // provider keys and could resolve an unrelated transcript/database row.
      const providerSessionId = session.provider_session_id?.trim() || null;
      if (!providerSessionId) {
        return emptyPendingSessionTokenUsage();
      }

      if (session.provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) {
          throw new AppError('OpenCode database was not found.', {
            code: 'OPENCODE_DATABASE_NOT_FOUND',
            statusCode: 404,
          });
        }

        return readOpenCodeTokenUsage(databasePath, providerSessionId);
      }

      if (session.provider === 'codex') {
        const codexSessionsRoot = path.join(getCodexHomeDirectory(), 'sessions');
        // The source project remains the sidebar owner, but an isolated
        // session's transcript must belong to its private runtime checkout.
        // Bind every indexed/fallback candidate to that effective cwd before
        // reading token counters.
        const expectedProjectPath = typeof session.runtime_path === 'string' && session.runtime_path.trim()
          ? session.runtime_path.trim()
          : typeof session.project_path === 'string' && session.project_path.trim()
            ? session.project_path.trim()
            : null;
        const resolveCandidate = async (candidatePath: string): Promise<ResolvedTranscript | null> => {
          const authenticated = await openAuthenticatedTranscript({
            provider: 'codex',
            candidatePath,
            rootPath: codexSessionsRoot,
            providerSessionId,
            expectedProjectPath,
          });
          return authenticated
            ? { canonicalPath: authenticated.canonicalPath, handle: authenticated.handle }
            : null;
        };
        const resolved = (session.jsonl_path
          ? await resolveCandidate(session.jsonl_path)
          : null)
          ?? await findCodexSessionFile(
            codexSessionsRoot,
            providerSessionId,
            dependencies,
            resolveCandidate,
          );

        if (!resolved) {
          throw new AppError(`Codex session file for "${sessionId}" was not found.`, {
            code: 'CODEX_SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        try {
          const tail = await readTextFileTailFromHandle(resolved.handle, TOKEN_USAGE_TAIL_BYTES);
          const tailUsage = findCodexTokenUsage(tail.content);
          if (tailUsage || tail.isComplete) {
            return tailUsage ?? emptyCodexTokenUsage();
          }

          // A tail this large with no token_count row is pathological, but
          // the whole descriptor is still authoritative when it happens.
          return findCodexTokenUsage(await readTextFileFromHandle(resolved.handle))
            ?? emptyCodexTokenUsage();
        } finally {
          await closeProviderTranscriptReadHandle(resolved.handle);
        }
      }

      const claudeProjectsRoot = path.join(getClaudeConfigDirectory(), 'projects');
      // Keep Claude token usage on the same runtime cwd as history/search.
      // Without this binding an isolated row can retain a source transcript
      // path and report the source conversation's usage.
      const expectedProjectPath = typeof session.runtime_path === 'string' && session.runtime_path.trim()
        ? session.runtime_path.trim()
        : typeof session.project_path === 'string' && session.project_path.trim()
          ? session.project_path.trim()
          : null;
      const resolveCandidate = async (candidatePath: string): Promise<ResolvedTranscript | null> => {
        const authenticated = await openAuthenticatedTranscript({
          provider: 'claude',
          candidatePath,
          rootPath: claudeProjectsRoot,
          providerSessionId,
          expectedProjectPath,
        });
        return authenticated
          ? { canonicalPath: authenticated.canonicalPath, handle: authenticated.handle }
          : null;
      };
      let resolved = session.jsonl_path
        ? await resolveCandidate(session.jsonl_path)
        : null;
      if (!resolved) {
        if (!expectedProjectPath) {
          throw new AppError(`Session file for "${sessionId}" was not found.`, {
            code: 'SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const candidatePath = buildClaudeTranscriptFilePath(
          getClaudeConfigDirectory(),
          expectedProjectPath,
          providerSessionId,
        );
        if (!candidatePath) {
          throw new AppError('Resolved session path is invalid.', {
            code: 'INVALID_SESSION_PATH',
            statusCode: 400,
          });
        }

        resolved = await resolveCandidate(candidatePath);
      }

      if (!resolved) {
        throw new AppError(`Session file for "${sessionId}" was not found.`, {
          code: 'SESSION_FILE_NOT_FOUND',
          statusCode: 404,
        });
      }

      try {
        const tail = await readTextFileTailFromHandle(resolved.handle, TOKEN_USAGE_TAIL_BYTES);
        let entries = parseClaudeUsageEntries(tail.content);
        if (!claudeEntriesHaveUsage(entries) && !tail.isComplete) {
          entries = parseClaudeUsageEntries(await readTextFileFromHandle(resolved.handle));
        }
        return summarizeClaudeTokenUsage(entries, dependencies.getClaudeContextWindow());
      } finally {
        await closeProviderTranscriptReadHandle(resolved.handle);
      }
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
