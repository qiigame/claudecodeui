import fsp from 'node:fs/promises';

import type { FetchHistoryResult } from '@/shared/types.js';

/**
 * Full-transcript cache for session history reads.
 *
 * Every provider history reader materializes the complete normalized
 * transcript and then slices out the requested page, so serving a 20-row page
 * of a large session re-read and re-parsed the whole transcript file on every
 * request — opening a session, each older page while scrolling up, and every
 * post-turn refresh. For a multi-megabyte JSONL that is most of a second of
 * CPU per request.
 *
 * Entries are keyed by app session id and validated with one `stat` per
 * request against the transcript file's identity (path + device + inode +
 * mtime + size), so a pathname replacement cannot reuse a stale snapshot even
 * when an attacker preserves the old timestamp and byte length. Only the
 * first read after the file changes pays the parse. Anything that
 * rewrites history (a new turn, an edit, a rewind, a fork) touches the file
 * and invalidates naturally; no explicit invalidation hooks exist or are
 * needed.
 *
 * Only history readers that read `jsonl_path` itself may use this cache —
 * callers pass no resolver for providers whose messages live elsewhere
 * (Cursor's store.db, OpenCode's shared SQLite), which bypasses caching
 * entirely.
 */

type CacheEntry = {
  transcriptPath: string;
  device: number;
  inode: number;
  mtimeMs: number;
  /** File size in bytes; doubles as the entry's cost against the byte budget. */
  size: number;
  full: FetchHistoryResult;
};

type CacheRequestIdentity = {
  transcriptPath: string | null;
  device: number | null;
  inode: number | null;
  mtimeMs: number | null;
  size: number | null;
  generation: number;
  /** False while the newest caller is still resolving its transcript path. */
  resolved: boolean;
};

type PendingLoad = {
  device: number;
  inode: number;
  mtimeMs: number;
  size: number;
  promise: Promise<FetchHistoryResult>;
  /** Set when a resolver failure or a newer file identity supersedes it. */
  invalidated: boolean;
};

type GetFullHistoryArgs = {
  sessionId: string;
  /**
   * Resolves and validates the file the provider's history reader parses.
   *
   * The resolver must return a canonical, regular file below the provider's
   * storage root, or `null` when the indexed path is absent/invalid.  It is
   * deliberately called before any cache `stat`: database paths are an
   * untrusted index and must never be touched by this cache directly.
   */
  resolveCanonicalTranscriptPath: (() => Promise<string | null>) | null | undefined;
  /** Loads the complete transcript (`limit: null, offset: 0`) from the provider. */
  loadFull: () => Promise<FetchHistoryResult>;
};

type SessionHistoryCacheOptions = {
  /** Optional internal observer used to verify/measure bookkeeping cleanup. */
  onSessionCleanup?: (sessionId: string) => void;
};

/**
 * A transcript entry's heap cost is roughly the file it was parsed from, so
 * the budget is expressed in file bytes. The newest entry is always retained
 * even when it alone exceeds the budget — evicting it would just re-parse the
 * same file on the next request.
 */
const MAX_CACHED_TRANSCRIPT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;

/**
 * Claude and Codex attach subagent data that is read from one or more rollout
 * files other than the parent transcript. Until the cache tracks those
 * dependency identities too, retaining such a result could serve stale child
 * activity/status after the child file changes while the parent stays still.
 * Keep the result available to concurrent waiters, but do not retain it.
 */
function hasSubagentReference(message: FetchHistoryResult['messages'][number]): boolean {
  if (
    message.subagent
    || message.subagentTools
    // Claude's built-in Agent/Task tools and Codex's normalized Task tool each
    // launch a child rollout even before a child result has been attached.
    || message.toolName === 'Agent'
    || message.toolName === 'Task'
  ) {
    return true;
  }

  // Claude's parent transcript can expose the agent id only through the
  // launch result. The provider may not have found the child file yet, so no
  // `subagent` object is attached; still treat the parent as dependent on a
  // separate transcript and avoid retaining this snapshot.
  const toolUseResults = [message.toolUseResult, message.toolResult?.toolUseResult];
  return toolUseResults.some((toolUseResult) => {
    if (!toolUseResult || typeof toolUseResult !== 'object') {
      return false;
    }
    const record = toolUseResult as Record<string, unknown>;
    return record.isAsync === true
      || ['agentId', 'agent_id', 'agentThreadId', 'agent_thread_id'].some((key) => (
        typeof record[key] === 'string' && record[key].trim().length > 0
      ));
  });
}

function isHistoryCacheable(full: FetchHistoryResult): boolean {
  return !full.messages.some(hasSubagentReference);
}

export function createSessionHistoryCache(
  maxTotalFileBytes = MAX_CACHED_TRANSCRIPT_FILE_BYTES,
  maxEntries = MAX_CACHE_ENTRIES,
  options: SessionHistoryCacheOptions = {},
) {
  const entries = new Map<string, CacheEntry>();
  // Pending work is scoped by both app session and canonical transcript path.
  // A session can be repointed while an old transcript is still parsing; a
  // session-id-only map would hand the old promise to the new path.
  const pendingLoads = new Map<string, Map<string, PendingLoad>>();
  // Monotonic generations prevent an older in-flight read from overwriting a
  // newer path (or newer file identity) that was requested for the same app
  // session before the old read completed.
  const latestRequestBySession = new Map<string, CacheRequestIdentity>();
  // A resolver/stat failure is a hard generation barrier.  It can happen
  // before an older request has installed its PendingLoad, so a boolean on
  // the pending record alone is not enough to stop that older request from
  // publishing work after invalidation.
  const invalidatedThroughGeneration = new Map<string, number>();
  // Keep each invocation alive until its resolver/load settles so bookkeeping
  // can be removed once no cache entry or pending load remains.
  const activeRequestsBySession = new Map<string, number>();

  function beginRequest(sessionId: string): number {
    const previous = latestRequestBySession.get(sessionId);
    const generation = (previous?.generation ?? 0) + 1;
    latestRequestBySession.set(sessionId, {
      transcriptPath: null,
      device: null,
      inode: null,
      mtimeMs: null,
      size: null,
      generation,
      resolved: false,
    });
    activeRequestsBySession.set(sessionId, (activeRequestsBySession.get(sessionId) ?? 0) + 1);
    return generation;
  }

  /**
   * Records the identity observed by the newest request only. An older
   * resolver may finish after a newer request has started, and must not move
   * the latest marker backwards.
   */
  function markRequestResolved(
    sessionId: string,
    generation: number,
    transcriptPath: string | null,
    device: number | null,
    inode: number | null,
    mtimeMs: number | null,
    size: number | null,
  ): void {
    const current = latestRequestBySession.get(sessionId);
    if (!current || current.generation !== generation) {
      return;
    }

    latestRequestBySession.set(sessionId, {
      transcriptPath,
      device,
      inode,
      mtimeMs,
      size,
      generation,
      resolved: true,
    });
  }

  function invalidateRequest(
    sessionId: string,
    generation: number,
  ): void {
    // An older request can fail after a newer request has already populated a
    // cache entry. Only the current request may invalidate that entry.
    if (latestRequestBySession.get(sessionId)?.generation !== generation) {
      return;
    }
    markRequestResolved(sessionId, generation, null, null, null, null, null);
    entries.delete(sessionId);
    invalidatedThroughGeneration.set(
      sessionId,
      Math.max(invalidatedThroughGeneration.get(sessionId) ?? 0, generation),
    );
    // A resolver failure or an invalidated indexed path is a generation
    // boundary.  Do not let a later request reuse a promise that started
    // before that boundary; the old caller may still await it, but its result
    // must no longer be discoverable as shared pending work.  The exact-promise
    // cleanup in getFullHistory remains safe when that old load settles.
    const pendingForSession = pendingLoads.get(sessionId);
    if (pendingForSession) {
      for (const pending of pendingForSession.values()) {
        pending.invalidated = true;
      }
      pendingLoads.delete(sessionId);
    }
  }

  function commitLoad(
    sessionId: string,
    transcriptPath: string,
    device: number,
    inode: number,
    mtimeMs: number,
    size: number,
    full: FetchHistoryResult,
  ): void {
    entries.delete(sessionId);
    entries.set(sessionId, {
      transcriptPath,
      device,
      inode,
      mtimeMs,
      size,
      full,
    });
    evictOverBudget();
  }

  function isGenerationInvalidated(sessionId: string, generation: number): boolean {
    return (invalidatedThroughGeneration.get(sessionId) ?? 0) >= generation;
  }

  function canCommitLoad(
    sessionId: string,
    generation: number,
    transcriptPath: string,
    device: number,
    inode: number,
    mtimeMs: number,
    size: number,
  ): boolean {
    const latest = latestRequestBySession.get(sessionId);
    if (!latest) {
      return false;
    }
    if (isGenerationInvalidated(sessionId, generation)) {
      return false;
    }
    // A newer request may still be resolving its path.  Let the current load
    // commit in that narrow window so ordinary concurrent same-path misses
    // still coalesce; if the newer resolver later fails/repoints, its
    // invalidation marks this PendingLoad stale before any subsequent commit.
    if (!latest.resolved) {
      return true;
    }
    if (latest.generation === generation) {
      return true;
    }
    // An older load may still be shared by a newer request, but it can only
    // commit after that request has authenticated the same file identity.  If
    // the newer resolver is still pending, or has failed/repointed, keep the
    // old result out of the cache.  The newer waiter commits it for itself
    // after the shared promise settles.
    return latest.resolved
      && latest.transcriptPath === transcriptPath
      && latest.device === device
      && latest.inode === inode
      && latest.mtimeMs === mtimeMs
      && latest.size === size;
  }

  function maybeCleanupSession(sessionId: string): void {
    if (
      !activeRequestsBySession.has(sessionId)
      && !entries.has(sessionId)
      && !pendingLoads.has(sessionId)
    ) {
      latestRequestBySession.delete(sessionId);
      invalidatedThroughGeneration.delete(sessionId);
      options.onSessionCleanup?.(sessionId);
    }
  }

  function finishRequest(sessionId: string): void {
    const active = activeRequestsBySession.get(sessionId) ?? 0;
    if (active <= 1) {
      activeRequestsBySession.delete(sessionId);
    } else {
      activeRequestsBySession.set(sessionId, active - 1);
    }
    maybeCleanupSession(sessionId);
  }

  function evictOverBudget(): void {
    let totalBytes = 0;
    for (const entry of entries.values()) {
      totalBytes += entry.size;
    }
    for (const key of entries.keys()) {
      if (entries.size <= 1 || (totalBytes <= maxTotalFileBytes && entries.size <= maxEntries)) {
        break;
      }
      totalBytes -= entries.get(key)!.size;
      entries.delete(key);
      maybeCleanupSession(key);
    }
  }

  return {
    /**
     * Returns the session's full transcript through the cache, or null when
     * the session is not cacheable (the resolver has no verified path, or the
     * file cannot be stat'ed) — the caller then falls back to a plain provider
     * read.  `stat` is intentionally performed only on the resolver's
     * canonical result, never on a raw database path.
     */
    async getFullHistory({
      sessionId,
      resolveCanonicalTranscriptPath,
      loadFull,
    }: GetFullHistoryArgs): Promise<FetchHistoryResult | null> {
      // Allocate the generation before any await. Otherwise a slower resolver
      // from an older invocation can become "latest" after a newer request.
      const generation = beginRequest(sessionId);

      try {
        if (!resolveCanonicalTranscriptPath) {
          // A non-cacheable request still invalidates any older load. Without
          // this, a stale promise could repopulate the cache after bypass.
          invalidateRequest(sessionId, generation);
          return null;
        }

        let transcriptPath: string | null;
        try {
          transcriptPath = await resolveCanonicalTranscriptPath();
        } catch {
          transcriptPath = null;
        }
        // The request may have been invalidated while its resolver was
        // suspended.  Do not even stat or install pending work for that old
        // generation; a later request must perform a fresh resolution.
        if (isGenerationInvalidated(sessionId, generation)) {
          return null;
        }
        if (!transcriptPath) {
          // Invalidate an older load too: a resolver failure/repoint must not
          // allow its eventual result to repopulate the cache under this id.
          invalidateRequest(sessionId, generation);
          return null;
        }

        let stat;
        try {
          // The resolver already authenticated the canonical path. Use lstat
          // here as a second, cheap race check so a replacement by a symlink
          // cannot turn a cache hit into a read through another target.
          stat = await fsp.lstat(transcriptPath);
        } catch {
          invalidateRequest(sessionId, generation);
          return null;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
          invalidateRequest(sessionId, generation);
          return null;
        }

        if (isGenerationInvalidated(sessionId, generation)) {
          return null;
        }

        markRequestResolved(
          sessionId,
          generation,
          transcriptPath,
          stat.dev,
          stat.ino,
          stat.mtimeMs,
          stat.size,
        );

        const cached = entries.get(sessionId);
        if (
          cached
          && cached.transcriptPath === transcriptPath
          && cached.device === stat.dev
          && cached.inode === stat.ino
          && cached.mtimeMs === stat.mtimeMs
          && cached.size === stat.size
        ) {
          // Re-insert to mark as most recently used.
          entries.delete(sessionId);
          entries.set(sessionId, cached);
          return cached.full;
        }

        // Concurrent requests for the same session *and file identity* share
        // one parse. A changed stat starts a fresh read instead of reusing a
        // promise that began before the append.
        let pendingForSession = pendingLoads.get(sessionId);
        const pending = pendingForSession?.get(transcriptPath);
        if (
          pending
          && !pending.invalidated
          && pending.device === stat.dev
          && pending.inode === stat.ino
          && pending.mtimeMs === stat.mtimeMs
          && pending.size === stat.size
        ) {
          // Await so the outer finally keeps this request active until the
          // shared load settles.
          const full = await pending.promise;
          // The creator may be an older generation.  Once this request has
          // resolved the same canonical identity, it becomes the safe owner
          // of the cache entry.
          if (
            !pending.invalidated
            && isHistoryCacheable(full)
            && canCommitLoad(
              sessionId,
              generation,
              transcriptPath,
              stat.dev,
              stat.ino,
              stat.mtimeMs,
              stat.size,
            )
          ) {
            commitLoad(sessionId, transcriptPath, stat.dev, stat.ino, stat.mtimeMs, stat.size, full);
          }
          return full;
        }

        // Reserve the pending slot before invoking the loader.  `loadFull`
        // may resolve synchronously (or its first await may already be
        // released), allowing another request's stat continuation to run
        // immediately; creating the promise through a microtask closes that
        // tiny coalescing race.
        let pendingRecord!: PendingLoad;
        const load = Promise.resolve().then(loadFull).then((full) => {
          // Do not let a stale read win a race against a newer transcript/path
          // request for this app session.
          if (
            !pendingRecord.invalidated
            && isHistoryCacheable(full)
            && canCommitLoad(
              sessionId,
              generation,
              transcriptPath,
              stat.dev,
              stat.ino,
              stat.mtimeMs,
              stat.size,
            )
          ) {
            commitLoad(sessionId, transcriptPath, stat.dev, stat.ino, stat.mtimeMs, stat.size, full);
          }
          return full;
        });
        if (!pendingForSession) {
          pendingForSession = new Map<string, PendingLoad>();
          pendingLoads.set(sessionId, pendingForSession);
        }
        pendingRecord = {
          mtimeMs: stat.mtimeMs,
          device: stat.dev,
          inode: stat.ino,
          size: stat.size,
          promise: load,
          invalidated: false,
        };
        // A changed stat for the same path starts a new generation of work;
        // make the previous record explicitly stale before replacing it so a
        // late completion cannot publish an older snapshot.
        const previousPending = pendingForSession.get(transcriptPath);
        if (previousPending) {
          previousPending.invalidated = true;
        }
        pendingForSession.set(transcriptPath, pendingRecord);
        try {
          return await load;
        } finally {
          // A newer stat/path may have replaced this map entry; only remove the
          // exact promise that this call installed.
          const currentForSession = pendingLoads.get(sessionId);
          if (currentForSession?.get(transcriptPath)?.promise === load) {
            currentForSession.delete(transcriptPath);
            if (currentForSession.size === 0) {
              pendingLoads.delete(sessionId);
            }
          }
        }
      } finally {
        finishRequest(sessionId);
      }
    },
  };
}

export const sessionHistoryCache = createSessionHistoryCache();
