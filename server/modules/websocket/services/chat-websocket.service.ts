import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { WebSocket } from 'ws';

import {
  collaborationService,
  executionAttributionService,
} from '@/modules/collaboration/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { terminateProviderShellSession } from '@/modules/websocket/services/shell-websocket.service.js';
import { hasDingTalkActor } from '@/modules/websocket/services/websocket-auth.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  filterExecutionEnvironmentForReadOnly,
  parseIncomingJsonObject,
  readAuthenticatedWebSocketUserId,
} from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());
  // The upload route creates regular files, but a stale/manual symlink can
  // still exist in the shared store.  Resolve existing entries here before a
  // provider Read tool sees them; missing files are kept through the lexical
  // check so queued messages retain their normal "file not found" behavior.
  let canonicalAssetsRoot = assetsRoot;
  try {
    canonicalAssetsRoot = path.resolve(realpathSync(assetsRoot));
  } catch {
    // The directory is created by POST /api/assets before normal dispatch.
    // Test/queued callers may validate descriptors before it exists.
  }

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (isDirectChild) {
      try {
        const canonicalResolved = path.resolve(realpathSync(resolved));
        const canonicalRelative = path.relative(canonicalAssetsRoot, canonicalResolved);
        if (
          canonicalRelative.length === 0
          || canonicalRelative.startsWith('..')
          || path.isAbsolute(canonicalRelative)
          || canonicalRelative.includes(path.sep)
          || canonicalRelative.includes('/')
        ) {
          console.warn(`[Chat] Dropping symlinked attachment outside the upload store: ${descriptor.path}`);
          return false;
        }
      } catch {
        // Preserve the descriptor when the file has not been materialized yet;
        // provider-specific readers will report a normal missing-file error.
      }
    }

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
  /** Startup-resolved deployment policy enforced before provider dispatch. */
  deploymentPolicy?: DeploymentPolicy;
  /**
   * Managed SSO transport admission requires an allowlisted DingTalk actor.
   * Person mapping is deliberately not implied by this authentication flag.
   */
  requireDingTalkActor?: boolean;
  /** Managed SSO sessions must carry a verified DingTalk project actor. */
  requireVerifiedDingTalkActor?: boolean;
  /**
   * Optional deployment-owned actor revalidator. When omitted, the gateway
   * re-reads the collaboration actor itself before every execution operation;
   * production may inject a testable equivalent without trusting socket data.
   */
  isActorVerified?: (userId: string | number) => boolean;
};

// Legacy/direct callers may omit the policy because they predate the startup
// composition root. Capture that fallback once, on the first gateway use, so
// changing process.env while the server is running can never reopen a denied
// chat capability. Production wiring supplies the composition-root snapshot
// explicitly and does not depend on this compatibility path.
let chatWebSocketStartupPolicy: DeploymentPolicy | undefined;

function getChatWebSocketStartupPolicy(): DeploymentPolicy {
  chatWebSocketStartupPolicy ??= parseDeploymentPolicy();
  return chatWebSocketStartupPolicy;
}

/**
 * Resolves the process-owned policy for direct/legacy chat entry points that
 * were composed before `deploymentPolicy` became an explicit dependency.
 * With no managed deployment environment this retains the writable
 * self-hosted default; a product/QA process can no longer fail open merely
 * because an alternate caller omitted the already-configured policy.
 */
function withResolvedChatDeploymentPolicy(
  dependencies: ChatWebSocketDependencies,
): ChatWebSocketDependencies {
  return dependencies.deploymentPolicy
    ? dependencies
    : { ...dependencies, deploymentPolicy: getChatWebSocketStartupPolicy() };
}

/**
 * Checks the capability required to open a chat read transport. Session
 * history/subscription is deliberately independent of provider runtime and
 * chat execution capabilities: a pure-read deployment can observe existing
 * runs even when no model process is enabled.
 */
function chatReadAllowed(dependencies: ChatWebSocketDependencies): boolean {
  const policy = dependencies.deploymentPolicy;
  return !policy || hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SESSION_READ);
}

/**
 * Checks the additional capability required by operations that create or
 * control provider state. Keeping this separate prevents a custom policy
 * with `session.write=false` from being bypassed through the websocket path.
 */
function chatExecutionAllowed(dependencies: ChatWebSocketDependencies): boolean {
  const policy = dependencies.deploymentPolicy;
  return !policy || (
    chatReadAllowed(dependencies)
    && hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SESSION_WRITE)
    && hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.CHAT_USE)
    && hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME)
  );
}

/**
 * Cursor and OpenCode do not currently expose a server-enforced read-only
 * contract. A product/QA deployment must fail closed for those runtimes until
 * their adapters can prove that every tool and filesystem operation is safe.
 */
function providerAllowedInReadOnlyChat(
  provider: string,
  dependencies: ChatWebSocketDependencies,
): boolean {
  const policy = dependencies.deploymentPolicy;
  return !policy
    || !isDeploymentReadOnly(policy)
    || (provider !== 'cursor' && provider !== 'opencode');
}

function sendDeploymentDenied(ws: WebSocket, message: string, sessionId?: string): void {
  sendProtocolError(ws, 'DEPLOYMENT_CAPABILITY_DENIED', message, sessionId);
}

function sendIdentityEnrollmentDenied(ws: WebSocket, sessionId?: string): void {
  sendProtocolError(
    ws,
    'IDENTITY_ENROLLMENT_REQUIRED',
    'A verified DingTalk project identity is required before starting a chat run.',
    sessionId,
  );
}

/**
 * Checks the stronger managed-identity gate for an operation that can affect
 * provider state. The socket itself may remain open for `chat.subscribe` when
 * this returns false, allowing a pending/ambiguous user to read sessions and
 * finish enrollment without receiving an execution channel.
 */
type ActorVerification = () => boolean;

/**
 * Internal control-flow error used when a managed actor is revoked while a
 * turn is being prepared.  Keeping this distinct from provider failures lets
 * `dispatchRun` release its reservation/attribution and return the same
 * identity error contract as the synchronous admission path, without ever
 * invoking the provider runtime.
 */
class ChatExecutionAdmissionError extends Error {
  readonly code = 'IDENTITY_ENROLLMENT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'ChatExecutionAdmissionError';
  }
}

function canExecuteChatOperation(
  dependencies: ChatWebSocketDependencies,
  actorVerified: ActorVerification,
): boolean {
  // A verified project-person identity is an optional, explicit execution
  // policy. DingTalk authentication by itself only proves access to this
  // deployment and must not turn a missing attribution mapping into an outage.
  if (!requiresManagedChatIdentity(dependencies)) {
    return true;
  }
  try {
    return actorVerified();
  } catch {
    // Identity revalidation is a security boundary. A database/registry
    // failure must not turn into a temporary execution bypass.
    return false;
  }
}

/**
 * Builds a request-independent verifier for a host that explicitly requires
 * verified person attribution. The
 * collaboration lookup refreshes a DingTalk subject against the current
 * registry, so a socket that was opened while an actor was verified cannot
 * keep executing after an administrator suspends or reassigns that subject.
 */
function createActorVerification(
  userId: string | number | null,
  dependencies: ChatWebSocketDependencies,
): ActorVerification {
  return () => {
    if (!requiresManagedChatIdentity(dependencies)) {
      return true;
    }
    if (userId === null) {
      return false;
    }
    if (dependencies.isActorVerified) {
      return dependencies.isActorVerified(userId);
    }
    // Use the write-boundary assertion rather than trusting the status cached
    // on the websocket principal.  The assertion re-resolves the current
    // registry subject (and, in managed mode, fails closed when the registry
    // is unavailable), so a revoked actor cannot keep a long-lived socket.
    collaborationService.assertActorCanWrite(userId, { requireRegistry: true });
    return true;
  };
}

function requiresManagedChatIdentity(dependencies: ChatWebSocketDependencies): boolean {
  // Authentication and project-person attribution are separate concerns.
  // A host must opt into this stronger gate explicitly; merely requiring a
  // DingTalk principal or selecting the read-only profile cannot disable chat.
  return dependencies.requireVerifiedDingTalkActor === true;
}

/**
 * Transport-level actor presence is stricter when the composition root has
 * explicitly enabled managed SSO.  A direct, policy-only unit/embedded caller
 * may omit `request.user` while exercising the pure read subscription path;
 * there is no principal to authenticate in that case, and execution is still
 * denied by `createActorVerification` below.  As soon as a policy-only caller
 * supplies a principal, require it to be a DingTalk actor just like the full
 * server composition.
 */
function requiresDingTalkActorAtTransport(
  request: AuthenticatedWebSocketRequest | undefined,
  dependencies: ChatWebSocketDependencies,
): boolean {
  return dependencies.requireDingTalkActor === true
    || dependencies.requireVerifiedDingTalkActor === true
    || (dependencies.deploymentPolicy?.profile === 'product-qa-readonly'
      && Boolean(request?.user));
}

function rejectUnverifiedChatOperation(
  ws: WebSocket,
  dependencies: ChatWebSocketDependencies,
  actorVerified: ActorVerification,
  sessionId?: string,
): boolean {
  if (canExecuteChatOperation(dependencies, actorVerified)) {
    return false;
  }
  sendIdentityEnrollmentDenied(ws, sessionId);
  return true;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  actorVerified: ActorVerification,
): Promise<void> {
  // Report a disabled execution capability before evaluating the stronger
  // actor gate.  This keeps standalone pure-read sockets (which intentionally
  // have no authenticated actor in unit/embedded tests) on the stable
  // DEPLOYMENT_CAPABILITY_DENIED contract while still requiring a verified
  // actor whenever execution is actually enabled.
  if (!chatExecutionAllowed(dependencies)) {
    sendDeploymentDenied(ws, 'Chat runtime access is disabled for this deployment.');
    return;
  }
  if (rejectUnverifiedChatOperation(ws, dependencies, actorVerified)) {
    return;
  }
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  await dispatchRun(
    ws,
    userId,
    resolved.sessionId,
    resolved.session,
    data,
    dependencies,
    {},
    undefined,
    'send',
    actorVerified,
  );
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  if (!chatExecutionAllowed(dependencies)) {
    sendDeploymentDenied(ws, 'Chat runtime access is disabled for this deployment.');
    return null;
  }

  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!providerAllowedInReadOnlyChat(provider, dependencies)) {
    sendProtocolError(
      ws,
      'PROVIDER_READ_ONLY_UNSUPPORTED',
      `Provider "${provider}" does not expose a safe read-only runtime in this deployment.`,
      sessionId,
    );
    return null;
  }
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
  attributionAction: 'send' | 'edit_send' = 'send',
  actorVerified: ActorVerification = () => true,
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;
  const identityAdmissionMessage =
    'A verified DingTalk project identity is required before starting a chat run.';

  // Capability checks are orthogonal to identity checks.  A disabled runtime
  // must fail with the deployment error even for a direct/embedded caller
  // that has no request principal; otherwise a pure-read subscription/test can
  // observe an identity-enrollment error for an operation that was disabled
  // before authentication.  Interactive handlers perform the same ordering
  // before they call this shared dispatcher.
  if (!chatExecutionAllowed(dependencies)) {
    const message = 'Chat runtime access is disabled for this deployment.';
    if (ws) {
      sendDeploymentDenied(ws, message, sessionId);
    }
    return { started: false, error: message };
  }

  if (!canExecuteChatOperation(dependencies, actorVerified)) {
    if (ws) {
      sendIdentityEnrollmentDenied(ws, sessionId);
    }
    return { started: false, error: identityAdmissionMessage };
  }

  if (!providerAllowedInReadOnlyChat(provider, dependencies)) {
    const message = `Provider "${provider}" does not expose a safe read-only runtime in this deployment.`;
    if (ws) {
      sendProtocolError(ws, 'PROVIDER_READ_ONLY_UNSUPPORTED', message, sessionId);
    }
    return { started: false, error: message };
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  let execution: ReturnType<typeof executionAttributionService.beginExecution>;
  try {
    // Actor attribution is part of admitting a turn, not best-effort logging.
    // If it cannot be persisted, the provider must not execute an unaudited
    // prompt in the shared workspace.
    collaborationService.recordSessionAction(sessionId, userId, attributionAction);
    execution = executionAttributionService.beginExecution({
      userId,
      sessionId,
      provider,
      projectPath: session.runtime_path ?? session.project_path ?? process.cwd(),
      // Identity mapping is attribution metadata, not permission to use an
      // authenticated chat. Commit hooks remain closed until it is verified.
      requireVerifiedIdentity: requiresManagedChatIdentity(dependencies),
    });
    void broadcastSessionUpserted(sessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[Chat] Could not broadcast actor attribution', { sessionId, error: message });
    });
  } catch (error) {
    chatRunRegistry.discardRunIfCurrent(run);
    const message = error instanceof Error ? error.message : String(error);
    if (ws) {
      sendProtocolError(ws, 'ACTOR_ATTRIBUTION_FAILED', message, sessionId);
    }
    return { started: false, error: message };
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The actor can be revoked between the initial frame admission and this
  // synchronous metadata/attachment preparation.  Do not persist a model
  // preference or proceed with a provider turn after that revocation.
  const assertActorForRun = (): void => {
    if (!canExecuteChatOperation(dependencies, actorVerified)) {
      throw new ChatExecutionAdmissionError(identityAdmissionMessage);
    }
  };
  try {
    assertActorForRun();
  } catch (error) {
    executionAttributionService.completeExecution(execution.runId, 'failed');
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    if (ws) {
      sendIdentityEnrollmentDenied(ws, sessionId);
    }
    return { started: false, error: error instanceof Error ? error.message : identityAdmissionMessage };
  }

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use. This follows the post-attribution
  // actor check above, so a revoked managed actor cannot mutate preferences.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    // Existing sessions are pinned to the server-owned filesystem root. A
    // browser cannot redirect a run with cwd/projectPath options.
    cwd: session.runtime_path ?? session.project_path ?? undefined,
    projectPath: session.runtime_path ?? session.project_path ?? undefined,
    // Server-created and deliberately applied after client options so a
    // browser cannot claim another actor or substitute a receipt token.
    executionEnvironment: dependencies.deploymentPolicy
      && isDeploymentReadOnly(dependencies.deploymentPolicy)
      ? filterExecutionEnvironmentForReadOnly(execution.environment)
      : execution.environment,
  };

  // This marker is consumed by provider adapters as a second, runtime-level
  // read-only boundary. Also overwrite all known client-controlled permission
  // toggles so a browser cannot smuggle `bypassPermissions` or an equivalent
  // mode through `options` while the deployment is read-only.
  if (dependencies.deploymentPolicy && isDeploymentReadOnly(dependencies.deploymentPolicy)) {
    runtimeOptions.deploymentReadOnly = true;
    // Provider adapters map `plan` to their strongest read-only mode (Claude's
    // plan permission mode and Codex's kernel-enforced read-only sandbox).
    runtimeOptions.permissionMode = 'plan';
    runtimeOptions.skipPermissions = false;
    runtimeOptions.bypassPermissions = false;
    runtimeOptions.allowDangerous = false;
    if (runtimeOptions.toolsSettings && typeof runtimeOptions.toolsSettings === 'object') {
      runtimeOptions.toolsSettings = {
        ...runtimeOptions.toolsSettings,
        skipPermissions: false,
      };
    }
  }

  let failure: string | null = null;
  let identityAdmissionDenied = false;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    if (provider === 'codex' || provider === 'claude') {
      // Shell keeps provider PTYs briefly for reconnects. Release one before
      // resume so the provider thread has exactly one active writer.
      await terminateProviderShellSession(sessionId, provider);
    }
    // `terminateProviderShellSession` can await a process handoff. Re-check
    // immediately before any edit rewind and before launching the provider so
    // a revoked long-lived websocket cannot race that await into execution.
    assertActorForRun();
    await beforeRun?.(run);
    // An edit's `beforeRun` hook may itself await a provider/filesystem
    // operation (and can rewind the transcript). The second check prevents
    // the provider from running after that preparation loses its identity;
    // the rewind is still recorded as part of the failed, attributed turn.
    assertActorForRun();
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    identityAdmissionDenied = error instanceof ChatExecutionAdmissionError;
    if (identityAdmissionDenied) {
      if (ws) {
        sendIdentityEnrollmentDenied(ws, sessionId);
      }
    } else {
      console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
    }
  } finally {
    executionAttributionService.completeExecution(
      execution.runId,
      failure ? 'failed' : 'succeeded',
    );
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: !identityAdmissionDenied, error: failure };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  actorVerified: ActorVerification,
): Promise<void> {
  if (!chatExecutionAllowed(dependencies)) {
    sendDeploymentDenied(ws, 'Chat runtime access is disabled for this deployment.');
    return;
  }
  if (rejectUnverifiedChatOperation(ws, dependencies, actorVerified)) {
    return;
  }
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  if (dependencies.deploymentPolicy && isDeploymentReadOnly(dependencies.deploymentPolicy)) {
    // Replacing a turn is not a metadata-only edit: Claude appends from an
    // earlier anchor and Codex forks/repoints its provider transcript.  Reject
    // before reading an anchor or reserving a provider run so product/QA mode
    // cannot mutate provider-owned files through chat.edit-send.
    sendDeploymentDenied(
      ws,
      'Editing existing conversation turns is disabled for the read-only deployment.',
      sessionId,
    );
    return;
  }

  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  let rewinds: boolean;
  try {
    // Both the provider-specific rewind path and Claude's anchor-resume path
    // mutate provider transcript state.  The sessions service rejects this
    // before a run is admitted in product/QA read-only mode.
    rewinds = sessionsService.providerRewindsForEdit(
      sessionId,
      dependencies.deploymentPolicy,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'DEPLOYMENT_CAPABILITY_DENIED', message, sessionId);
    return;
  }

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(
            sessionId,
            resumeThroughId,
            dependencies.deploymentPolicy,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
    'edit_send',
    actorVerified,
  );
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  actorVerified: ActorVerification,
): Promise<void> {
  if (!chatExecutionAllowed(dependencies)) {
    sendDeploymentDenied(ws, 'Chat execution is disabled for this deployment.');
    return;
  }
  if (rejectUnverifiedChatOperation(ws, dependencies, actorVerified)) {
    return;
  }
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const success = await dependencies.runtime.abort(run.provider, sessionId);

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly when a provider
    // runtime is enabled. A pure-read deployment intentionally has no runtime
    // capability; do not invoke a missing/disabled runtime just to subscribe
    // to session state. The fallback also keeps a malformed optional adapter
    // from turning a harmless read subscription into an INTERNAL_ERROR frame.
    const providerRuntimeEnabled = !dependencies.deploymentPolicy
      || hasDeploymentCapability(
        dependencies.deploymentPolicy,
        DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
      );
    let pendingPermissions: unknown[] = [];
    if (providerRuntimeEnabled) {
      try {
        const getPendingApprovals = dependencies.runtime.getPendingApprovalsForSession;
        pendingPermissions = typeof getPendingApprovals === 'function'
          ? getPendingApprovals.call(dependencies.runtime, sessionId) ?? []
          : [];
      } catch {
        pendingPermissions = [];
      }
    }

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  actorVerified: ActorVerification,
): void {
  if (!chatExecutionAllowed(dependencies)) {
    sendDeploymentDenied(ws, 'Chat execution is disabled for this deployment.');
    return;
  }
  if (rejectUnverifiedChatOperation(ws, dependencies, actorVerified)) {
    return;
  }
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  if (
    dependencies.deploymentPolicy
    && isDeploymentReadOnly(dependencies.deploymentPolicy)
    && Boolean(data.allow)
  ) {
    // A denial is safe and lets an already-pending provider request settle;
    // accepting an approval would let a client turn a permission prompt into
    // a write-capable tool invocation, so it is rejected at this boundary.
    sendDeploymentDenied(
      ws,
      'Tool approvals that could execute mutations are disabled for the read-only deployment.',
    );
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is already busy, which the caller reports on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null }> {
  dependencies = withResolvedChatDeploymentPolicy(dependencies);
  if (!chatExecutionAllowed(dependencies)) {
    return { started: false, error: 'Chat runtime access is disabled for this deployment.' };
  }

  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const provider = session.provider as LLMProvider;
  if (!providerAllowedInReadOnlyChat(provider, dependencies)) {
    return {
      started: false,
      error: `Provider "${provider}" does not expose a safe read-only runtime in this deployment.`,
    };
  }
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  if (chatRunRegistry.isProcessing(input.sessionId)) {
    return { started: false, error: 'A run was already in progress for this session.' };
  }

  // Detached turns normally originate from the server-side scheduler, but
  // keep the same verified-actor boundary as interactive websocket turns. A
  // pending/ambiguous user must not smuggle a scheduled provider execution by
  // reusing a session created by another actor.
  const actorVerified = createActorVerification(input.userId, dependencies);
  if (!canExecuteChatOperation(dependencies, actorVerified)) {
    return {
      started: false,
      error: 'A verified DingTalk project identity is required before starting a chat run.',
    };
  }

  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
    {},
    undefined,
    'send',
    actorVerified,
  );
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  dependencies = withResolvedChatDeploymentPolicy(dependencies);
  // The upgrade boundary requires a DingTalk principal in managed SSO mode,
  // but deliberately allows pending/ambiguous actors through so they can
  // subscribe to and read existing sessions while enrollment is completed.
  if (requiresDingTalkActorAtTransport(request, dependencies)
    && !hasDingTalkActor(request?.user)) {
    if (ws.readyState === WS_OPEN_STATE) {
      sendProtocolError(
        ws,
        'DINGTALK_LOGIN_REQUIRED',
        'DingTalk login is required for this deployment.',
      );
      const close = (ws as WebSocket & { close?: (code?: number, reason?: string) => void }).close;
      if (typeof close === 'function') {
        close.call(ws, 1008, 'DingTalk login required');
      }
    }
    return;
  }
  if (!chatReadAllowed(dependencies)) {
    if (ws.readyState === WS_OPEN_STATE) {
      sendDeploymentDenied(ws, 'Chat runtime access is disabled for this deployment.');
      const close = (ws as WebSocket & { close?: (code?: number, reason?: string) => void }).close;
      if (typeof close === 'function') {
        close.call(ws, 1008, 'Chat runtime access is disabled');
      }
    }
    return;
  }

  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readAuthenticatedWebSocketUserId(request);
  // Keep the initial actor-presence check above cheap, but revalidate the
  // verified status from the collaboration registry for every execution frame.
  const actorVerified = createActorVerification(userId, dependencies);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies, actorVerified);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies, actorVerified);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies, actorVerified);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(ws, data, dependencies, actorVerified);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
