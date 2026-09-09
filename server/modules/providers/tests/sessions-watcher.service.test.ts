import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeSessionsWatcher } from '@/modules/providers/services/sessions-watcher.service.js';

type WatcherDependencies = NonNullable<Parameters<typeof initializeSessionsWatcher>[1]>;

function testDependencies(overrides: Partial<WatcherDependencies> = {}): WatcherDependencies {
  return {
    synchronizeSessions: async () => ({
      processedByProvider: { claude: 0, codex: 0, cursor: 0, opencode: 0 },
      prunedOrphans: 0,
      failures: [],
    }),
    prepareRoot: async () => true,
    getProviderWatchPaths: () => [],
    watch: (() => {
      throw new Error('watch should not be called by this test');
    }) as WatcherDependencies['watch'],
    ...overrides,
  };
}

test('disabled session watcher startup has no synchronization or filesystem side effects', async () => {
  let synchronizeCalls = 0;
  let prepareRootCalls = 0;
  let providerPathCalls = 0;
  let watchCalls = 0;

  await initializeSessionsWatcher(
    { enabled: false, createMissingRoots: true },
    testDependencies({
      synchronizeSessions: async () => {
        synchronizeCalls += 1;
        return {
          processedByProvider: { claude: 0, codex: 0, cursor: 0, opencode: 0 },
          prunedOrphans: 0,
          failures: [],
        };
      },
      prepareRoot: async () => {
        prepareRootCalls += 1;
        return true;
      },
      getProviderWatchPaths: () => {
        providerPathCalls += 1;
        return [{ provider: 'claude', rootPath: '/should-not-be-read' }];
      },
      watch: (() => {
        watchCalls += 1;
        throw new Error('watch should not be called when disabled');
      }) as WatcherDependencies['watch'],
    }),
  );

  assert.equal(synchronizeCalls, 0);
  assert.equal(prepareRootCalls, 0);
  assert.equal(providerPathCalls, 0);
  assert.equal(watchCalls, 0);
});

test('enabled session watcher startup retains the developer synchronization path', async () => {
  let synchronizeCalls = 0;
  await initializeSessionsWatcher(
    { enabled: true, createMissingRoots: false },
    testDependencies({
      synchronizeSessions: async () => {
        synchronizeCalls += 1;
        return {
          processedByProvider: { claude: 0, codex: 0, cursor: 0, opencode: 0 },
          prunedOrphans: 0,
          failures: [],
        };
      },
    }),
  );

  assert.equal(synchronizeCalls, 1);
});
