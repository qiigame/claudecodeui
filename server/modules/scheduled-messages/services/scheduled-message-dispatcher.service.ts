import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { AUTH_DEPLOYMENT_MODE } from '@/modules/auth/index.js';
import { collaborationService } from '@/modules/collaboration/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;

// The dispatcher is normally given the composition-root policy. Keep one
// lazy snapshot for legacy/direct callers so a runtime environment mutation
// cannot change whether queued work is executable halfway through a process.
let scheduledMessageStartupPolicy: DeploymentPolicy | undefined;

function getScheduledMessageStartupPolicy(): DeploymentPolicy {
  scheduledMessageStartupPolicy ??= parseDeploymentPolicy();
  return scheduledMessageStartupPolicy;
}

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

type DetachedTurnIdentityOptions = {
  requireVerifiedDingTalkActor?: boolean;
  isActorVerified?: (userId: string | number) => boolean;
};

const detachedTurnIdentityOptions = (): DetachedTurnIdentityOptions => ({
  requireVerifiedDingTalkActor: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
  isActorVerified: (userId) => {
    try {
      // Detached turns have no request principal to refresh. Reuse the same
      // write-boundary assertion as interactive chat so a queued/scheduled
      // run cannot retain a cached verified row after registry revocation or
      // execute while the managed registry is unavailable.
      collaborationService.assertActorCanWrite(userId, {
        // Local developer dispatch retains its historical account path;
        // managed DingTalk dispatch requires the registry explicitly even
        // when this helper is composed without server/index.ts.
        requireRegistry: AUTH_DEPLOYMENT_MODE.requiresDingTalk,
      });
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * Returns whether a dispatcher pass may launch an agent turn. Direct callers
 * that do not inject the startup policy still resolve the trusted environment
 * policy, so a DingTalk/read-only process cannot bypass the guard by invoking
 * a helper without an argument.
 */
function dispatcherExecutionAllowed(policy?: DeploymentPolicy): boolean {
  const effectivePolicy = policy ?? getScheduledMessageStartupPolicy();
  return hasDeploymentCapability(effectivePolicy, DEPLOYMENT_CAPABILITIES.AGENT_USE);
}

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
  deploymentPolicy: DeploymentPolicy,
  identityOptions: DetachedTurnIdentityOptions = detachedTurnIdentityOptions(),
): Promise<void> {
  const message = readQueuedMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    {
      runtime,
      deploymentPolicy,
      ...identityOptions,
    },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again. A
  // pending/ambiguous identity is also a temporary admission failure: keep
  // the user's queued turn instead of silently deleting it while an operator
  // completes enrollment and the user signs in again.
  const admissionBlocked = result.error === 'A verified DingTalk project identity is required before starting a chat run.';
  if (!result.started && (
    result.error === 'A run was already in progress for this session.'
    || admissionBlocked
  )) {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(
  runtime: ProviderRuntimeGateway,
  deploymentPolicy?: DeploymentPolicy,
  identityOptions?: DetachedTurnIdentityOptions,
): Promise<number> {
  const effectivePolicy = deploymentPolicy ?? getScheduledMessageStartupPolicy();
  if (!dispatcherExecutionAllowed(effectivePolicy)) {
    return 0;
  }

  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if (chatRunRegistry.isProcessing(candidate.sessionId)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, runtime, effectivePolicy, identityOptions);
  }));

  return claimed;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
  deploymentPolicy: DeploymentPolicy,
  identityOptions: DetachedTurnIdentityOptions = detachedTurnIdentityOptions(),
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
      },
      {
        runtime,
        deploymentPolicy,
        ...identityOptions,
      },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider, session already busy) or started
    // and then failed. Silently dropping a message the user scheduled is worse
    // than telling them it did not go.
    const admissionBlocked = result.error === 'A verified DingTalk project identity is required before starting a chat run.';
    if (!result.started && admissionBlocked) {
      // claimDue marks the row as sent before invoking the provider. Identity
      // enrollment is a temporary admission condition, so put it back into
      // pending instead of losing the user's scheduled turn.
      scheduledMessagesDb.restorePending(row.id);
      return;
    }
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'A verified DingTalk project identity is required before starting a chat run.') {
      scheduledMessagesDb.restorePending(row.id);
      return;
    }
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
  deploymentPolicy?: DeploymentPolicy,
  identityOptions?: DetachedTurnIdentityOptions,
): Promise<number> {
  const effectivePolicy = deploymentPolicy ?? getScheduledMessageStartupPolicy();
  if (!dispatcherExecutionAllowed(effectivePolicy)) {
    return 0;
  }

  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime, effectivePolicy, identityOptions);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(
  runtime: ProviderRuntimeGateway,
  deploymentPolicy?: DeploymentPolicy,
): void {
  // Resolve the policy at the composition boundary when a caller does not
  // provide one. This prevents a future startup path from accidentally
  // inheriting enabled schedules in a read-only/DingTalk deployment.
  const effectivePolicy = deploymentPolicy ?? getScheduledMessageStartupPolicy();
  if (!dispatcherExecutionAllowed(effectivePolicy)) {
    // A policy change cannot normally happen within one process, but stopping
    // an already-running timer here makes the guard safe for tests and for
    // hot-reload/composition code that re-initializes services.
    closeScheduledMessageDispatcher();
    console.log('[ScheduledMessages] Dispatcher startup skipped by deployment policy');
    return;
  }

  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime, new Date(), effectivePolicy)
      .then(() => dispatchQueuedMessages(runtime, effectivePolicy))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
