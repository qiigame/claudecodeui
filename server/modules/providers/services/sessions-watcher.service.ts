import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { broadcastSessionUpsertedBatch } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { resolveClaudeConfigDirectory, resolveCodexHomeDirectory } from '@/shared/utils.js';

type WatcherEventType = 'add' | 'change';

/**
 * Startup options for the provider-session filesystem watcher.
 *
 * Developer/self-hosted instances historically created missing provider
 * roots so a first-run installation could start watching immediately. A
 * managed read-only deployment must not create directories below a service
 * account's HOME (or accidentally make an immutable provider mount look
 * writable), so callers can disable startup entirely. When startup is enabled,
 * `createMissingRoots` retains the legacy choice of creating absent roots;
 * session indexing itself remains an application state/SQLite operation and
 * does not write provider files.
 */
export type SessionsWatcherOptions = {
  /**
   * Whether startup should perform the initial provider scan and register
   * filesystem watchers. Read-only deployments set this to false because both
   * operations can lead to application-index writes or long-lived polling.
   * The default remains true for developer/self-hosted compatibility.
   */
  enabled?: boolean;
  createMissingRoots?: boolean;
};

function getProviderWatchPaths(): Array<{ provider: LLMProvider; rootPath: string }> {
  return [
    {
      provider: 'claude',
      rootPath: path.join(resolveClaudeConfigDirectory(), 'projects'),
    },
    {
      provider: 'cursor',
      rootPath: path.join(os.homedir(), '.cursor', 'projects'),
    },
    {
      provider: 'codex',
      rootPath: path.join(resolveCodexHomeDirectory(), 'sessions'),
    },
    {
      provider: 'opencode',
      rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
    },
  ];
}

type SessionsWatcherDependencies = {
  synchronizeSessions: typeof sessionSynchronizerService.synchronizeSessions;
  prepareRoot: (rootPath: string, createMissingRoots: boolean) => Promise<boolean>;
  getProviderWatchPaths: typeof getProviderWatchPaths;
  watch: typeof chokidar.watch;
};

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/subagents/**',
  '**/tool-results/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

const watchers: FSWatcher[] = [];

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    await broadcastSessionUpsertedBatch(queuedUpdate.updatedSessionIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/** Returns whether a provider watch root already exists as a directory. */
async function isExistingDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(targetPath)).isDirectory();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

/**
 * Ensures a provider root is ready for chokidar. A false result means the
 * caller should skip that provider because its root is absent in a mode that
 * is not allowed to create directories.
 */
async function prepareWatchRoot(
  rootPath: string,
  createMissingRoots: boolean,
): Promise<boolean> {
  if (createMissingRoots) {
    await fsPromises.mkdir(rootPath, { recursive: true });
    return true;
  }

  return isExistingDirectory(rootPath);
}

const defaultDependencies: SessionsWatcherDependencies = {
  synchronizeSessions: () => sessionSynchronizerService.synchronizeSessions(),
  prepareRoot: prepareWatchRoot,
  getProviderWatchPaths,
  watch: chokidar.watch,
};

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 * The composition root passes `enabled: false` for product/QA read-only
 * deployments; that path returns before touching the synchronizer, filesystem,
 * or chokidar. The optional dependency bundle is kept for deterministic
 * provider-module tests and is omitted by normal callers.
 */
export async function initializeSessionsWatcher(
  options: SessionsWatcherOptions = {},
  dependencies: SessionsWatcherDependencies = defaultDependencies,
): Promise<void> {
  if (options.enabled === false) {
    console.log('Session watchers disabled by deployment policy');
    return;
  }

  const createMissingRoots = options.createMissingRoots !== false;
  console.log('Setting up session watchers');

  const initialSync = await dependencies.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    prunedOrphans: initialSync.prunedOrphans,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of dependencies.getProviderWatchPaths()) {
    try {
      if (!(await dependencies.prepareRoot(rootPath, createMissingRoots))) {
        // Chokidar can wait for a path to appear, but doing so here would make
        // a read-only deployment keep a watcher for a path it is not allowed
        // to create. The provider synchronizers already treat absent roots as
        // empty, so skipping this provider is both quieter and fail-closed.
        console.log(`Skipping session watcher for provider "${provider}" because its root is absent in read-only mode`, {
          rootPath,
        });
        continue;
      }

      const watcher = dependencies.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}
