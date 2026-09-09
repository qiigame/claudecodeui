import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

import { scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';
import {
  isExpectedProviderTranscriptFileName,
  resolveClaudeConfigDirectory,
  resolveCodexHomeDirectory,
  validateProviderTranscriptPath,
} from '@/shared/utils.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  /** Indexed sessions dropped because their transcript file no longer exists. */
  prunedOrphans: number;
  failures: string[];
};

type IndexedTranscriptRow = {
  session_id: string;
  provider: 'claude' | 'codex';
  provider_session_id: string | null;
  project_path: string | null;
  runtime_path: string | null;
  jsonl_path: string;
  isArchived: number;
  updated_at: string | null;
};

function providerTranscriptRoot(provider: string): string | null {
  if (provider === 'claude') {
    return path.join(resolveClaudeConfigDirectory(), 'projects');
  }
  if (provider === 'codex') {
    return path.join(resolveCodexHomeDirectory(), 'sessions');
  }
  return null;
}

function isSafeProviderSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !path.isAbsolute(value)
    && !/[\\/:\0-\x1f\x7f]/.test(value)
    && path.basename(value) === value;
}

function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

/**
 * Returns true when a missing candidate's parent contains a symlink below the
 * provider root.  A dangling or retargetable parent must not be treated as a
 * provider-owned directory merely because its current realpath happens to be
 * inside the root.
 */
async function hasSymlinkedParentComponent(
  lexicalRoot: string,
  lexicalCandidate: string,
): Promise<boolean> {
  const relativeParent = path.relative(lexicalRoot, path.dirname(lexicalCandidate));
  if (
    relativeParent === '..'
    || relativeParent.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeParent)
  ) {
    return true;
  }

  if (!relativeParent) {
    return false;
  }

  let currentPath = lexicalRoot;
  for (const segment of relativeParent.split(path.sep)) {
    if (!segment || segment === '.') {
      continue;
    }
    currentPath = path.join(currentPath, segment);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        return true;
      }
    } catch {
      // A missing/inaccessible parent is handled by the realpath check below;
      // fail closed here so a race cannot turn it into an orphan signal.
      return true;
    }
  }

  return false;
}

/**
 * Returns true only when a transcript is absent from a verified provider root
 * and its containing directory still exists inside that root. This is the
 * narrow condition under which orphan pruning may remove a database row;
 * existing but malformed/symlinked artifacts are retained for investigation.
 */
async function isSafeMissingTranscript(row: IndexedTranscriptRow): Promise<boolean> {
  const rootPath = providerTranscriptRoot(row.provider);
  if (!rootPath || !isSafeProviderSessionId(row.provider_session_id)) {
    return false;
  }

  const rawPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
  if (!rawPath || !path.isAbsolute(rawPath) || !rawPath.toLowerCase().endsWith('.jsonl')) {
    return false;
  }
  if (!isExpectedProviderTranscriptFileName(
    row.provider,
    rawPath,
    row.provider_session_id,
  )) {
    return false;
  }

  try {
    const lexicalRoot = path.resolve(rootPath);
    const candidatePath = path.resolve(rawPath);
    const canonicalRoot = path.resolve(await realpath(lexicalRoot));
    const candidateIsLexicallyInside = isPathInsideOrEqual(lexicalRoot, candidatePath)
      && candidatePath !== lexicalRoot;
    const candidateIsCanonicallyInside = isPathInsideOrEqual(canonicalRoot, candidatePath)
      && candidatePath !== canonicalRoot;
    if (!candidateIsLexicallyInside && !candidateIsCanonicallyInside) {
      return false;
    }
    // A deployment may expose the provider root through a symlink.  Stored
    // paths are normally canonical, so use the canonical root for those;
    // lexical paths still get the stricter below-root symlink check.
    if (
      candidateIsLexicallyInside
      && await hasSymlinkedParentComponent(lexicalRoot, candidatePath)
    ) {
      return false;
    }

    const canonicalParent = path.resolve(await realpath(path.dirname(candidatePath)));
    if (!isPathInsideOrEqual(canonicalRoot, canonicalParent)) {
      return false;
    }

    // Claude top-level transcripts are exactly one encoded project directory
    // below `<claude-config>/projects`.  Without this depth check a deleted
    // subagent/tool-result file (or an arbitrary nested `.jsonl`) could look
    // like the missing main transcript. Codex's date layout is intentionally
    // variable, so only its provider-owned filename convention is enforced.
    const canonicalCandidate = path.join(canonicalParent, path.basename(candidatePath));
    if (row.provider === 'claude') {
      const relativeParts = path.relative(canonicalRoot, canonicalCandidate)
        .split(path.sep);
      if (relativeParts.length !== 2) {
        return false;
      }
    }

    // A successful lstat means the artifact exists (including a symlink or a
    // directory); those cases must not be mistaken for a missing transcript.
    const parentStat = await lstat(canonicalParent);
    if (!parentStat.isDirectory()) {
      return false;
    }
    try {
      await lstat(candidatePath);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  } catch {
    // Missing/unmounted roots and inaccessible parents are intentionally kept.
    return false;
  }
}

/**
 * Removes indexed sessions whose transcript file has disappeared from disk.
 *
 * Nothing else deletes these rows: the synchronizers only ever upsert, and the
 * watcher reacts to `add`/`change` but not `unlink`. A transcript removed by
 * hand — or written by a test run that pointed at the real `~/.claude` — left a
 * permanent sidebar entry that opened an empty "Untitled" session.
 *
 * A row is only dropped when its *containing directory* still exists. That
 * keeps an unmounted or not-yet-created home from being read as "every
 * transcript was deleted" and wiping the whole index.
 */
const pruneOrphanedSessions = async (): Promise<number> => {
  let pruned = 0;

  for (const row of sessionsDb.getSessionsWithTranscriptPath() as IndexedTranscriptRow[]) {
    if (row.provider !== 'claude' && row.provider !== 'codex') {
      continue;
    }
    const rootPath = providerTranscriptRoot(row.provider);
    if (!rootPath || !isSafeProviderSessionId(row.provider_session_id)) {
      continue;
    }

    const canonicalPath = await validateProviderTranscriptPath({
      provider: row.provider,
      candidatePath: row.jsonl_path,
      rootPath,
      providerSessionId: row.provider_session_id,
      expectedSubagent: false,
    });
    if (canonicalPath) {
      continue;
    }

    if (!(await isSafeMissingTranscript(row))) {
      continue;
    }

    if (sessionsDb.deleteOrphanIfUnchanged(row)) {
      pruned += 1;
    }
  }

  return pruned;
};

/**
 * The scan that every `synchronizeSessions()` caller shares while it runs.
 *
 * Opening the UI fires `/api/projects` and `/api/projects/archived` at once,
 * and each used to start its own full provider scan from the same
 * `last_scanned_at` cursor: identical work over identical transcripts,
 * contending for the same synchronous SQLite writes and doubling how long the
 * sidebar sits on its loading screen. Callers that arrive while a scan is
 * already running now await that scan instead of starting another.
 */
let inFlightSynchronization: Promise<SessionSynchronizeResult> | null = null;

/**
 * Runs all provider synchronizers and updates scan_state.last_scanned_at.
 */
async function runSessionSynchronization(): Promise<SessionSynchronizeResult> {
  const lastScanAt = scanStateDb.getLastScannedAt();
  const scanBoundary = new Date();
  const processedByProvider: Record<LLMProvider, number> = {
    claude: 0,
    codex: 0,
    cursor: 0,
    opencode: 0,
  };
  const failures: string[] = [];

  const results = await Promise.allSettled(
    providerRegistry.listProviders().map(async (provider) => ({
      provider: provider.id,
      processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
    }))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      processedByProvider[result.value.provider] = result.value.processed;
      continue;
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(reason);
  }

  // Pruning is skipped after a partial sync: a provider that just failed may
  // not have re-indexed transcripts it would otherwise have re-created.
  const prunedOrphans = failures.length === 0 ? await pruneOrphanedSessions() : 0;

  if (failures.length === 0) {
    scanStateDb.updateLastScannedAt(scanBoundary);
  } else {
    console.warn(
      `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
    );
  }

  return {
    processedByProvider,
    prunedOrphans,
    failures,
  };
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Scans every provider for new or changed sessions, coalescing concurrent
   * callers onto a single scan.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    if (inFlightSynchronization) {
      return inFlightSynchronization;
    }

    inFlightSynchronization = runSessionSynchronization().finally(() => {
      inFlightSynchronization = null;
    });

    return inFlightSynchronization;
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
