import assert from 'node:assert/strict';
import { appendFile, lstat, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import type { FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';

function historyResult(marker: string): FetchHistoryResult {
  const message = {
    id: marker,
    sessionId: 'session',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: marker,
  } as NormalizedMessage;

  return { messages: [message], total: 1, hasMore: false, offset: 0, limit: null };
}

async function withTranscriptFile(
  runTest: (transcriptPath: string) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-cache-'));
  const transcriptPath = path.join(tempDirectory, 'session.jsonl');
  await writeFile(transcriptPath, '{"type":"user"}\n', 'utf8');
  try {
    await runTest(transcriptPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('an unchanged transcript file is loaded once and then served from cache', async () => {
  await withTranscriptFile(async (transcriptPath) => {
    const cache = createSessionHistoryCache();
    let loads = 0;
    const loadFull = async () => {
      loads += 1;
      return historyResult(`load-${loads}`);
    };

    const resolveCanonicalTranscriptPath = async () => transcriptPath;
    const first = await cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath, loadFull });
    const second = await cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath, loadFull });

    assert.equal(loads, 1);
    assert.equal(second, first);
  });
});

test('growing the transcript file invalidates the cached load', async () => {
  await withTranscriptFile(async (transcriptPath) => {
    const cache = createSessionHistoryCache();
    let loads = 0;
    const loadFull = async () => {
      loads += 1;
      return historyResult(`load-${loads}`);
    };

    const resolveCanonicalTranscriptPath = async () => transcriptPath;
    await cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath, loadFull });
    await appendFile(transcriptPath, '{"type":"assistant"}\n', 'utf8');
    const afterAppend = await cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath, loadFull });

    assert.equal(loads, 2);
    assert.equal(afterAppend?.messages[0]?.id, 'load-2');
  });
});

test('replacing a transcript at the same path does not reuse a same-size timestamp-preserved cache entry', async () => {
  await withTranscriptFile(async (transcriptPath) => {
    const cache = createSessionHistoryCache();
    let loads = 0;
    const loadFull = async () => {
      loads += 1;
      return historyResult(`load-${loads}`);
    };
    const resolveCanonicalTranscriptPath = async () => transcriptPath;

    // Use a filesystem-representable timestamp so the replacement can retain
    // the exact same path metadata; inode is then the differentiating signal.
    const fixedTimestamp = new Date(1_700_000_000_000);
    await utimes(transcriptPath, fixedTimestamp, fixedTimestamp);
    await cache.getFullHistory({ sessionId: 'replaced-session', resolveCanonicalTranscriptPath, loadFull });
    const originalStat = await lstat(transcriptPath);
    const replacementPath = `${transcriptPath}.replacement`;
    // Keep the byte length and timestamps identical. Device/inode is the only
    // remaining identity signal that can distinguish this pathname replacement.
    await writeFile(replacementPath, '{"type":"new!"}\n', 'utf8');
    await utimes(replacementPath, originalStat.atime, originalStat.mtime);
    await rename(replacementPath, transcriptPath);

    const replacementStat = await lstat(transcriptPath);
    assert.equal(replacementStat.size, originalStat.size);
    assert.equal(replacementStat.mtimeMs, originalStat.mtimeMs);
    assert.notEqual(replacementStat.ino, originalStat.ino);

    const afterReplacement = await cache.getFullHistory({
      sessionId: 'replaced-session',
      resolveCanonicalTranscriptPath,
      loadFull,
    });

    assert.equal(loads, 2);
    assert.equal(afterReplacement?.messages[0]?.id, 'load-2');
  });
});

test('history with subagent data is not retained in the cache', async () => {
  await withTranscriptFile(async (transcriptPath) => {
    const cache = createSessionHistoryCache();
    let loads = 0;
    const loadFull = async () => {
      loads += 1;
      const result = historyResult(`load-${loads}`);
      result.messages[0] = {
        ...result.messages[0],
        kind: 'tool_use',
        toolName: 'Agent',
        toolResult: { toolUseResult: { agentId: 'agent-1', isAsync: true } },
      };
      return result;
    };
    const resolveCanonicalTranscriptPath = async () => transcriptPath;

    const firstRequest = cache.getFullHistory({
      sessionId: 'subagent-session',
      resolveCanonicalTranscriptPath,
      loadFull,
    });
    const first = await firstRequest;

    const second = await cache.getFullHistory({
      sessionId: 'subagent-session',
      resolveCanonicalTranscriptPath,
      loadFull,
    });
    // Subagent activity is read from an independent rollout file. Since the
    // cache does not yet track that dependency, a later caller must load fresh
    // data instead of retaining the composite result.
    assert.equal(loads, 2);
    assert.notEqual(second, first);
    const toolUseResult = first?.messages[0]?.toolResult?.toolUseResult as { agentId?: string } | undefined;
    assert.equal(toolUseResult?.agentId, 'agent-1');
  });
});

test('a missing transcript path or file bypasses the cache', async () => {
  const cache = createSessionHistoryCache();
  let loads = 0;
  const loadFull = async () => {
    loads += 1;
    return historyResult('unused');
  };

  assert.equal(await cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath: null, loadFull }), null);
  assert.equal(
    await cache.getFullHistory({
      sessionId: 's1',
      resolveCanonicalTranscriptPath: async () => path.join(os.tmpdir(), 'session-history-cache-does-not-exist.jsonl'),
      loadFull,
    }),
    null,
  );
  assert.equal(loads, 0);
});

test('concurrent misses share a single load', async () => {
  await withTranscriptFile(async (transcriptPath) => {
    const cache = createSessionHistoryCache();
    let loads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loadFull = async () => {
      loads += 1;
      await gate;
      return historyResult(`load-${loads}`);
    };

    const resolveCanonicalTranscriptPath = async () => transcriptPath;
    const firstRequest = cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath, loadFull });
    const secondRequest = cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath, loadFull });
    release!();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    assert.equal(loads, 1);
    assert.equal(second, first);
  });
});

test('a repointed session does not reuse or overwrite a pending load from its old transcript', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-cache-repoint-'));
  try {
    const firstPath = path.join(tempDirectory, 'first.jsonl');
    const secondPath = path.join(tempDirectory, 'second.jsonl');
    await writeFile(firstPath, 'first\n', 'utf8');
    await writeFile(secondPath, 'second\n', 'utf8');

    const cache = createSessionHistoryCache();
    let firstRelease: (() => void) | undefined;
    let secondRelease: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { firstRelease = resolve; });
    const secondGate = new Promise<void>((resolve) => { secondRelease = resolve; });
    const loads: string[] = [];
    const started = new Map<string, () => void>();
    const firstStarted = new Promise<void>((resolve) => { started.set('first', resolve); });
    const secondStarted = new Promise<void>((resolve) => { started.set('second', resolve); });
    const loadFor = (pathMarker: string, gate: Promise<void>) => async () => {
      loads.push(pathMarker);
      started.get(pathMarker)?.();
      await gate;
      return historyResult(pathMarker);
    };

    const firstRequest = cache.getFullHistory({
      sessionId: 'repointed-session',
      resolveCanonicalTranscriptPath: async () => firstPath,
      loadFull: loadFor('first', firstGate),
    });
    // Let the first request reach its loader before switching the indexed path.
    await firstStarted;
    const secondRequest = cache.getFullHistory({
      sessionId: 'repointed-session',
      resolveCanonicalTranscriptPath: async () => secondPath,
      loadFull: loadFor('second', secondGate),
    });

    // Both paths must have independent in-flight work.
    await secondStarted;
    assert.deepEqual(loads, ['first', 'second']);
    secondRelease!();
    const second = await secondRequest;
    firstRelease!();
    await firstRequest;

    assert.equal(second?.messages[0]?.id, 'second');
    // The newer path remains the cache winner after the stale first read ends.
    const cachedSecond = await cache.getFullHistory({
      sessionId: 'repointed-session',
      resolveCanonicalTranscriptPath: async () => secondPath,
      loadFull: loadFor('unexpected-reload', Promise.resolve()),
    });
    assert.equal(cachedSecond?.messages[0]?.id, 'second');
    assert.deepEqual(loads, ['first', 'second']);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('a failed resolver invalidates an old pending load before a later request', async () => {
  await withTranscriptFile(async (transcriptPath) => {
    const cache = createSessionHistoryCache();
    let releaseOldStarted: (() => void) | undefined;
    const oldStarted = new Promise<void>((resolve) => { releaseOldStarted = resolve; });
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let loads = 0;

    const oldRequest = cache.getFullHistory({
      sessionId: 'invalidated-session',
      resolveCanonicalTranscriptPath: async () => transcriptPath,
      loadFull: async () => {
        loads += 1;
        releaseOldStarted!();
        await oldGate;
        return historyResult('old');
      },
    });
    await oldStarted;

    // A failed/repointed lookup must make the still-running old promise
    // undiscoverable by the next request for this app session.
    const invalidation = await cache.getFullHistory({
      sessionId: 'invalidated-session',
      resolveCanonicalTranscriptPath: async () => null,
      loadFull: async () => historyResult('unused'),
    });
    assert.equal(invalidation, null);

    const laterRequest = cache.getFullHistory({
      sessionId: 'invalidated-session',
      resolveCanonicalTranscriptPath: async () => transcriptPath,
      loadFull: async () => {
        loads += 1;
        return historyResult('new');
      },
    });
    const later = await laterRequest;
    assert.equal(later?.messages[0]?.id, 'new');
    assert.equal(loads, 2);

    releaseOld!();
    const old = await oldRequest;
    assert.equal(old?.messages[0]?.id, 'old');

    const cachedLater = await cache.getFullHistory({
      sessionId: 'invalidated-session',
      resolveCanonicalTranscriptPath: async () => transcriptPath,
      loadFull: async () => {
        throw new Error('later request was unexpectedly evicted');
      },
    });
    assert.equal(cachedLater?.messages[0]?.id, 'new');
    assert.equal(loads, 2);
  });
});

test('invalidation also blocks an older resolver that has not installed a pending load', async () => {
  await withTranscriptFile(async (transcriptPath) => {
    const cache = createSessionHistoryCache();
    let releaseOldResolver: (() => void) | undefined;
    const oldResolverGate = new Promise<void>((resolve) => { releaseOldResolver = resolve; });
    let loads = 0;

    const oldRequest = cache.getFullHistory({
      sessionId: 'pre-pending-invalidation',
      resolveCanonicalTranscriptPath: async () => {
        await oldResolverGate;
        return transcriptPath;
      },
      loadFull: async () => {
        loads += 1;
        return historyResult('should-not-run');
      },
    });

    const invalidation = await cache.getFullHistory({
      sessionId: 'pre-pending-invalidation',
      resolveCanonicalTranscriptPath: async () => null,
      loadFull: async () => historyResult('unused'),
    });
    assert.equal(invalidation, null);

    releaseOldResolver!();
    assert.equal(await oldRequest, null);
    assert.equal(loads, 0);

    const fresh = await cache.getFullHistory({
      sessionId: 'pre-pending-invalidation',
      resolveCanonicalTranscriptPath: async () => transcriptPath,
      loadFull: async () => {
        loads += 1;
        return historyResult('fresh');
      },
    });
    assert.equal(fresh?.messages[0]?.id, 'fresh');
    assert.equal(loads, 1);
  });
});

test('a slower older resolver cannot overwrite a newer request', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-cache-order-'));
  try {
    const firstPath = path.join(tempDirectory, 'first.jsonl');
    const secondPath = path.join(tempDirectory, 'second.jsonl');
    await writeFile(firstPath, 'first\n', 'utf8');
    await writeFile(secondPath, 'second\n', 'utf8');

    const cache = createSessionHistoryCache();
    let releaseFirstResolver: (() => void) | undefined;
    const firstResolverGate = new Promise<void>((resolve) => { releaseFirstResolver = resolve; });
    let firstLoads = 0;
    let secondLoads = 0;

    const firstRequest = cache.getFullHistory({
      sessionId: 'out-of-order-session',
      resolveCanonicalTranscriptPath: async () => {
        await firstResolverGate;
        return firstPath;
      },
      loadFull: async () => {
        firstLoads += 1;
        return historyResult('first');
      },
    });
    // Ensure the older request is suspended inside its resolver before the
    // newer request starts and resolves.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const secondRequest = cache.getFullHistory({
      sessionId: 'out-of-order-session',
      resolveCanonicalTranscriptPath: async () => secondPath,
      loadFull: async () => {
        secondLoads += 1;
        return historyResult('second');
      },
    });
    const second = await secondRequest;
    releaseFirstResolver!();
    await firstRequest;

    // The late first request may still return its own read, but it must not
    // displace the newer path in the cache.
    const cachedSecond = await cache.getFullHistory({
      sessionId: 'out-of-order-session',
      resolveCanonicalTranscriptPath: async () => secondPath,
      loadFull: async () => {
        throw new Error('newer path was unexpectedly reloaded');
      },
    });

    assert.equal(second?.messages[0]?.id, 'second');
    assert.equal(cachedSecond?.messages[0]?.id, 'second');
    assert.equal(firstLoads, 1);
    assert.equal(secondLoads, 1);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the oldest entries are evicted over budget, but the newest survives alone', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-cache-evict-'));
  try {
    const firstPath = path.join(tempDirectory, 'first.jsonl');
    const secondPath = path.join(tempDirectory, 'second.jsonl');
    // Each file is 100 bytes, so a 150-byte budget holds exactly one entry —
    // and the newest entry stays cached even though it exceeds nothing alone.
    await writeFile(firstPath, 'x'.repeat(100), 'utf8');
    await writeFile(secondPath, 'y'.repeat(100), 'utf8');

    const cache = createSessionHistoryCache(150);
    const loadsBySession = new Map<string, number>();
    const loaderFor = (sessionId: string) => async () => {
      loadsBySession.set(sessionId, (loadsBySession.get(sessionId) ?? 0) + 1);
      return historyResult(sessionId);
    };

    await cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath: async () => firstPath, loadFull: loaderFor('s1') });
    await cache.getFullHistory({ sessionId: 's2', resolveCanonicalTranscriptPath: async () => secondPath, loadFull: loaderFor('s2') });

    // s2 is still cached; s1 was evicted to fit the budget.
    await cache.getFullHistory({ sessionId: 's2', resolveCanonicalTranscriptPath: async () => secondPath, loadFull: loaderFor('s2') });
    await cache.getFullHistory({ sessionId: 's1', resolveCanonicalTranscriptPath: async () => firstPath, loadFull: loaderFor('s1') });

    assert.equal(loadsBySession.get('s2'), 1);
    assert.equal(loadsBySession.get('s1'), 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('evicting a session releases its request bookkeeping', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-history-cache-cleanup-'));
  try {
    const firstPath = path.join(tempDirectory, 'first.jsonl');
    const secondPath = path.join(tempDirectory, 'second.jsonl');
    await writeFile(firstPath, 'a', 'utf8');
    await writeFile(secondPath, 'b', 'utf8');

    const cleanedSessions: string[] = [];
    const cache = createSessionHistoryCache(1, 1, {
      onSessionCleanup: (sessionId) => cleanedSessions.push(sessionId),
    });
    const loads = new Map<string, number>();
    const loaderFor = (sessionId: string) => async () => {
      loads.set(sessionId, (loads.get(sessionId) ?? 0) + 1);
      return historyResult(sessionId);
    };

    await cache.getFullHistory({
      sessionId: 'cleanup-s1',
      resolveCanonicalTranscriptPath: async () => firstPath,
      loadFull: loaderFor('cleanup-s1'),
    });
    await cache.getFullHistory({
      sessionId: 'cleanup-s2',
      resolveCanonicalTranscriptPath: async () => secondPath,
      loadFull: loaderFor('cleanup-s2'),
    });

    // s1 is evicted and its latest-request state can now be discarded.
    assert.equal(cleanedSessions.includes('cleanup-s1'), true);

    await cache.getFullHistory({
      sessionId: 'cleanup-s1',
      resolveCanonicalTranscriptPath: async () => firstPath,
      loadFull: loaderFor('cleanup-s1'),
    });
    assert.equal(loads.get('cleanup-s1'), 2);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
