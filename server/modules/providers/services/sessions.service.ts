import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb, sessionWorkspacesDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted, chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  SessionWorkspaceService,
  SessionWorkspaceSummary,
} from '@/shared/types.js';
import {
  AppError,
  closeProviderTranscriptReadHandle,
  normalizeProjectPath,
  openValidatedProviderTranscript,
  resolveClaudeConfigDirectory,
  resolveCodexHomeDirectory,
  sliceTailPage,
} from '@/shared/utils.js';

// Direct service callers do not carry an Express request on which the
// composition root can attach its policy. Resolve this once when the module is
// loaded so an alternate caller cannot silently fall back to a writable
// developer path in a managed/read-only process. HTTP callers may still pass
// the composition-root snapshot explicitly; it takes precedence below.
const sessionServiceStartupPolicy = parseDeploymentPolicy();

/**
 * Rejects history reads whose provider adapter would consult provider-owned
 * ambient storage in a read-only deployment. Cursor and OpenCode keep their
 * transcripts in shared user databases rather than an app-indexed,
 * descriptor-validated transcript, so exposing those readers would let a
 * QA process inspect the service account's provider data.
 */
function assertProviderHistoryReadAllowed(
  provider: LLMProvider,
  deploymentPolicy: DeploymentPolicy,
): void {
  if (
    isDeploymentReadOnly(deploymentPolicy)
    && (provider === 'cursor' || provider === 'opencode')
  ) {
    throw new AppError(
      `Provider "${provider}" history is not available in the read-only deployment.`,
      {
        code: 'PROVIDER_READ_ONLY_UNSUPPORTED',
        statusCode: 403,
        details: { provider },
      },
    );
  }
}

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  sessionName: string;
  workspace?: SessionWorkspaceSummary | null;
};

type CreateProjectSessionInput = {
  provider: LLMProvider;
  projectId?: string;
  projectPath: string;
  initialMessage: string;
  repositoryKeys: string[];
  userId: number;
  /** Startup-resolved deployment policy; never sourced from the browser. */
  deploymentPolicy?: DeploymentPolicy;
};

/**
 * Filesystem-backed provider session operations (forking, deleting a
 * transcript, or rewinding an append-only thread) are deliberately separate
 * from ordinary session metadata writes.  Product/QA deployments can create,
 * rename, archive, and restore the SQLite session row, but must never cause a
 * provider transcript or thread to be copied/removed on disk.  Keep this
 * service-level check in addition to the HTTP route guard so scheduled or
 * future callers cannot accidentally bypass the deployment boundary.
 */
function assertSessionFilesystemMutationAllowed(
  deploymentPolicy: DeploymentPolicy | undefined,
  operation: string,
): void {
  const effectivePolicy = deploymentPolicy ?? sessionServiceStartupPolicy;

  if (
    isDeploymentReadOnly(effectivePolicy)
    || !hasDeploymentCapability(effectivePolicy, DEPLOYMENT_CAPABILITIES.FILE_WRITE)
  ) {
    throw new AppError(`${operation} is disabled for the read-only deployment.`, {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
      statusCode: 403,
      details: {
        profile: effectivePolicy.profile,
        capability: DEPLOYMENT_CAPABILITIES.FILE_WRITE,
      },
    });
  }
}

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  workspace: SessionWorkspaceSummary | null;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_WORDS = 4;

function buildCloudCliSessionName(initialMessage: string): string {
  const words = initialMessage.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_CLOUDCLI_SESSION_NAME_WORDS).join(' ') || 'Untitled Session';
}

/**
 * Removes one already-validated regular file if it exists.
 *
 * The caller performs provider-root and transcript-metadata validation.  The
 * extra `lstat` is a cheap last-mile guard against a final component being
 * replaced with a symlink between that validation and `unlink`.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await fsp.lstat(filePath);
    if (!fileStat.isFile()) {
      return false;
    }
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Resolves either the stable app id or the provider-native id to one indexed
 * session row. The app id is always the canonical id returned to callers.
 */
function resolveSessionRowByAnyId(sessionId: string) {
  const byAppId = sessionsDb.getSessionById(sessionId);
  if (byAppId) {
    return byAppId;
  }

  return sessionsDb.getSessionByProviderSessionId(sessionId);
}

/**
 * Validates the indexed JSONL path before the history cache may stat it.
 *
 * `sessions.jsonl_path` is a database index, not a trust boundary. Keep this
 * resolver next to the cache call so a future cache caller cannot accidentally
 * reintroduce a raw-path filesystem access. Providers still validate once more
 * when they actually parse a cache miss; this first pass establishes the
 * canonical cache key and makes cache hits independent of the lexical DB path.
 */
async function resolveCanonicalSessionTranscriptPath(
  provider: LLMProvider,
  transcriptPath: string | null,
  providerSessionId: string,
  expectedProjectPath?: string | null,
): Promise<string | null> {
  if ((provider !== 'claude' && provider !== 'codex') || !transcriptPath) {
    return null;
  }

  const rootPath = provider === 'claude'
    ? path.join(resolveClaudeConfigDirectory(), 'projects')
    : path.join(resolveCodexHomeDirectory(), 'sessions');

  const authenticated = await openValidatedProviderTranscript({
    provider,
    candidatePath: transcriptPath,
    rootPath,
    providerSessionId,
    expectedSubagent: false,
    expectedProjectPath: expectedProjectPath ?? null,
  });
  if (!authenticated) {
    return null;
  }
  try {
    return authenticated.canonicalPath;
  } finally {
    await closeProviderTranscriptReadHandle(authenticated.handle);
  }
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return chatRunRegistry.listRunningRuns();
  },

  /**
   * Returns the active conversation feed in true global activity order.
   */
  listRecentSessions(limit: number, offset: number): RecentSessionsPage {
    const page = sessionsDb.getRecentSessionsPage(limit, offset);
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project: ReturnType<typeof projectsDb.getProjectPath> = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    // Legacy disk-indexed rows are backfilled with their native id in
    // `provider_session_id`. A freshly-created app row keeps that column NULL
    // until the runtime announces a native id; returning the app id in that
    // case would make a brand-new conversation resume an unrelated rollout.
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible CloudCLI message and is limited to
   * four whole words before any provider-owned storage exists.
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    initialMessage: string,
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(initialMessage);
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, sessionName);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
      sessionName,
    };
  },

  /**
   * Creates a conversation and, when local policy enables it, atomically binds
   * that conversation to a private multi-repository worktree root. The source
   * project remains the sidebar owner; only runtime_path points at the hidden
   * workspace project.
   */
  async createProjectSession(
    input: CreateProjectSessionInput,
    workspaceService: SessionWorkspaceService,
  ): Promise<CreateAppSessionResult> {
    const effectivePolicy = input.deploymentPolicy ?? sessionServiceStartupPolicy;
    const requestedPath = input.projectPath.trim();
    const sourceProject = input.projectId
      ? projectsDb.getProjectById(input.projectId)
      : requestedPath
        ? projectsDb.getProjectPath(requestedPath)
        : null;
    if (!sourceProject || sourceProject.isSessionWorkspace) {
      throw new AppError('The selected project was not found.', {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }
    if (requestedPath && normalizeProjectPath(requestedPath) !== sourceProject.project_path) {
      throw new AppError('The selected project path does not match its project id.', {
        code: 'PROJECT_ID_PATH_MISMATCH',
        statusCode: 400,
      });
    }

    // Creating the app-session row is itself a session metadata mutation. The
    // HTTP route normally enforces this capability before reaching the
    // service, but keep the service boundary explicit for scheduled/future
    // callers that invoke it directly with a startup policy.
    if (!hasDeploymentCapability(effectivePolicy, DEPLOYMENT_CAPABILITIES.SESSION_WRITE)) {
      throw new AppError('Creating a session is disabled for this deployment.', {
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        statusCode: 403,
        details: {
          profile: effectivePolicy.profile,
          capability: DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
        },
      });
    }

    // A product/QA deployment deliberately does not even *plan* an isolated
    // worktree.  Planning is currently read-only, but it loads deployment
    // workspace configuration and can make a future implementation perform
    // remote/Git work.  More importantly, provisioning would create branches,
    // fetch remotes, and expose a writable runtime path.  Bind the app session
    // to the already-registered source checkout instead; provider adapters
    // enforce their own read-only tool/sandbox contract for that path.
    const canProvisionWorkspace = !isDeploymentReadOnly(effectivePolicy)
      && hasDeploymentCapability(effectivePolicy, DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE)
      && hasDeploymentCapability(effectivePolicy, DEPLOYMENT_CAPABILITIES.FILE_WRITE)
      && hasDeploymentCapability(effectivePolicy, DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE)
      && hasDeploymentCapability(effectivePolicy, DEPLOYMENT_CAPABILITIES.SESSION_WRITE);

    // Do not infer worktree write authority from an unrelated mutation
    // capability (for example provider.write). A custom developer policy may
    // intentionally permit session metadata/configuration writes while
    // keeping project records and repository/worktree files immutable; in that
    // case bind the session to the registered source checkout and skip all
    // planning and provisioning side effects.
    if (!canProvisionWorkspace) {
      return sessionsService.createAppSession(
        input.provider,
        sourceProject.project_path,
        input.initialMessage,
      );
    }

    const plan = await workspaceService.plan(sourceProject.project_path);
    if (!plan.enabled) {
      return sessionsService.createAppSession(
        input.provider,
        sourceProject.project_path,
        input.initialMessage,
      );
    }

    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(input.initialMessage);
    const provisioned = await workspaceService.provision({
      sessionId,
      sourceProjectPath: sourceProject.project_path,
      repositoryKeys: input.repositoryKeys,
    });
    let workspaceProjectId: string | null = null;
    try {
      const workspaceProject = projectsDb.createSessionWorkspacePath(
        provisioned.workspacePath,
        `${sourceProject.custom_project_name || path.basename(sourceProject.project_path)} · ${sessionName}`,
      );
      workspaceProjectId = workspaceProject.project_id;
      sessionsDb.createAppSession(
        sessionId,
        input.provider,
        sourceProject.project_path,
        sessionName,
        provisioned.workspacePath,
      );
      sessionWorkspacesDb.create({
        sessionId,
        sourceProjectId: sourceProject.project_id,
        sourceProjectPath: sourceProject.project_path,
        workspaceProjectId,
        workspacePath: provisioned.workspacePath,
        branchPrefix: provisioned.branchPrefix,
        createdByUserId: input.userId,
        repositories: provisioned.repositories,
      });

      return {
        sessionId,
        provider: input.provider,
        projectPath: sourceProject.project_path,
        sessionName,
        workspace: {
          projectId: workspaceProjectId,
          path: provisioned.workspacePath,
          branchPrefix: provisioned.branchPrefix,
          repositories: provisioned.repositories,
        },
      };
    } catch (error) {
      sessionsDb.deleteSessionById(sessionId);
      if (workspaceProjectId) {
        projectsDb.deleteProjectById(workspaceProjectId);
      }
      await workspaceService.rollback(provisioned).catch((rollbackError) => {
        console.error('[Sessions] Failed to compensate session workspace provisioning', rollbackError);
      });
      throw error;
    }
  },

  /**
   * Branches a session into an independent one containing its conversation up
   * to `upToAnchorId` (the whole thing when omitted).
   *
   * The source is left completely untouched — this is the "try two approaches"
   * action, not a destructive one.
   */
  async forkSessionById(
    sessionId: string,
    options: { upToAnchorId?: string; title?: string } = {},
    deploymentPolicy?: DeploymentPolicy,
  ): Promise<CreateAppSessionResult> {
    const source = sessionsDb.getSessionById(sessionId);
    if (!source) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Provider forks copy transcript files (and Codex invokes
    // `thread/fork`).  This is a filesystem mutation, unlike copying the
    // SQLite session metadata, so keep the check before resolving/invoking a
    // provider adapter in a read-only deployment.
    assertSessionFilesystemMutationAllowed(deploymentPolicy, 'Forking a session');

    if (source.runtime_path) {
      throw new AppError('Forking an isolated session requires a new workspace and is not enabled yet.', {
        code: 'ISOLATED_SESSION_FORK_REQUIRES_NEW_WORKSPACE',
        statusCode: 409,
      });
    }

    const provider = source.provider as LLMProvider;
    const fork = providerRegistry.resolveProvider(provider).fork;
    if (!fork) {
      throw new AppError(`Sessions cannot be forked for provider "${provider}".`, {
        code: 'FORK_NOT_SUPPORTED',
        statusCode: 409,
      });
    }

    // A session that has never run has no transcript to copy, so there is
    // nothing a fork of it could resume from.
    if (!source.provider_session_id || !source.jsonl_path) {
      throw new AppError('This session has not produced a transcript yet.', {
        code: 'FORK_SOURCE_NOT_READY',
        statusCode: 409,
      });
    }

    const sessionName = options.title?.trim()
      || `${source.custom_name?.trim() || 'Session'} (fork)`;

    const forked = await fork.forkSession({
      providerSessionId: source.provider_session_id,
      jsonlPath: source.jsonl_path,
      projectPath: source.project_path ?? '',
      upToAnchorId: options.upToAnchorId,
      title: sessionName,
    });

    const forkSessionId = randomUUID();
    sessionsDb.createForkedSession({
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      customName: sessionName,
      providerSessionId: forked.providerSessionId,
      jsonlPath: forked.jsonlPath,
      forkedFromSessionId: sessionId,
      // A fork that silently dropped to the catalog default would answer
      // differently from the conversation it was branched from.
      model: source.model,
      effort: source.effort,
    });

    await broadcastSessionUpserted(forkSessionId);

    return {
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      sessionName,
    };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Resolves where a conversation must resume from so that one already-sent
   * message, and everything after it, is replaced.
   *
   * Returns `null` when the provider cannot do this at all, which is how the
   * chat gateway knows to refuse the request rather than silently sending the
   * edit as a new message at the end of the conversation.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null } | null> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    if (!sessions.resolveEditAnchor) {
      return null;
    }

    return sessions.resolveEditAnchor(sessionId, anchorId);
  },

  /**
   * Whether editing a message on this session's provider means rewinding it on
   * disk first, rather than handing the anchor to the runtime as a resume
   * option.
   *
   * Answering this without doing anything is the point: the rewind moves the
   * session onto a different provider transcript and cannot be undone, so the
   * gateway has to know which shape the run takes before it commits to one.
   */
  providerRewindsForEdit(
    sessionId: string,
    deploymentPolicy?: DeploymentPolicy,
  ): boolean {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Even providers that expose an anchor-based resume (rather than an
    // explicit `rewindSession` method) append/branch provider transcript data
    // when an edit is sent.  Reject the whole edit operation in product/QA
    // mode before dispatchRun reserves a run or emits a truncation event.
    assertSessionFilesystemMutationAllowed(deploymentPolicy, 'Editing a session transcript');

    return Boolean(providerRegistry.resolveProvider(session.provider as LLMProvider).sessions.rewindSession);
  },

  /**
   * Rewinds a session on disk so `keepThroughId` is the last row it holds.
   *
   * Only call this once the run is admitted — see `providerRewindsForEdit`.
   */
  async rewindSessionForEdit(
    sessionId: string,
    keepThroughId: string | null,
    deploymentPolicy?: DeploymentPolicy,
  ): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Claude/Codex rewind by replacing or branching provider transcript data;
    // never allow that side effect through the product/QA deployment.
    assertSessionFilesystemMutationAllowed(deploymentPolicy, 'Editing a session transcript');

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    await sessions.rewindSession?.(sessionId, keepThroughId);
  },

  /**
   * Fetches persisted history by app session id or provider-native id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * canonical app id plus the provider-native session id (the one written
   * into transcripts on disk), and every returned message is remapped back to
   * the app session id so provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
    deploymentPolicy?: DeploymentPolicy,
  ): Promise<FetchHistoryResult> {
    // Deep links and older share URLs can carry the provider-native id. Keep
    // the app id as the canonical key for the cache and for frontend events;
    // provider adapters still receive the native id through their lookup hint.
    const session = resolveSessionRowByAnyId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = session.provider as LLMProvider;
    assertProviderHistoryReadAllowed(
      provider,
      deploymentPolicy ?? sessionServiceStartupPolicy,
    );

    // App-created sessions that never produced a provider transcript yet
    // (e.g. the first message is still streaming) have no history. Never fall
    // back to the app id here: it is an opaque CloudCLI id and can collide with
    // an unrelated provider rollout filename. Legacy disk-indexed rows are
    // backfilled with `provider_session_id` during database migration.
    const providerSessionId = session.provider_session_id;
    if (!providerSessionId) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const appSessionId = session.session_id;
    const providerSessions = providerRegistry.resolveProvider(provider).sessions;
    // `project_path` identifies the source checkout used for sidebar grouping;
    // an isolated session must be read from its private runtime checkout.
    // Pass the effective runtime cwd to every provider so history fallback
    // cannot accidentally search the source project's transcript namespace.
    const projectPath = session.runtime_path ?? session.project_path ?? '';
    const requestedLimit = options.limit ?? null;
    const requestedOffset = options.offset ?? 0;

    // Claude and Codex history readers parse `jsonl_path` itself, so a page
    // can be sliced from the stat-validated full-transcript cache instead of
    // re-parsing the whole file per request. Cursor and OpenCode read their
    // messages from elsewhere (store.db / shared SQLite), so that file's stat
    // says nothing about their history — they stay on the direct path.
    const transcriptPath = provider === 'claude' || provider === 'codex'
      ? session.jsonl_path
      : null;
    const fullHistory = await sessionHistoryCache.getFullHistory({
      sessionId: appSessionId,
      resolveCanonicalTranscriptPath: transcriptPath && providerSessionId
        ? () => resolveCanonicalSessionTranscriptPath(
          provider,
          transcriptPath,
          providerSessionId,
          projectPath,
        )
        : null,
      loadFull: () => providerSessions.fetchHistory(appSessionId, {
        limit: null,
        offset: 0,
        projectPath,
        providerSessionId,
      }),
    });

    let result: FetchHistoryResult;
    if (fullHistory) {
      // Providers slice with this same helper, so a cached page is identical
      // to what a direct `(limit, offset)` read would have returned.
      const { page, hasMore } = sliceTailPage(fullHistory.messages, requestedLimit, Math.max(0, requestedOffset));
      result = {
        ...fullHistory,
        messages: page,
        hasMore,
        offset: requestedOffset,
        limit: requestedLimit,
      };
    } else {
      result = await providerSessions.fetchHistory(appSessionId, {
        limit: requestedLimit,
        offset: requestedOffset,
        projectPath,
        providerSessionId,
      });
    }

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId: appSessionId,
      })),
    };
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session = resolveSessionRowByAnyId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      workspace: sessionWorkspacesDb.getBySessionId(session.session_id),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project: ReturnType<typeof projectsDb.getProjectPath> = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
    deploymentPolicy?: DeploymentPolicy,
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    // A force delete is still useful as a metadata cleanup operation, but
    // unlinking provider transcripts is not permitted in read-only mode.
    // The route defaults `deletedFromDisk` to true for force deletes, so this
    // check must run before any unlink attempt.
    if (options.deletedFromDisk) {
      assertSessionFilesystemMutationAllowed(deploymentPolicy, 'Deleting a session transcript');
    }

    if (session.runtime_path) {
      throw new AppError(
        'Isolated session workspaces cannot be permanently deleted until their branches are archived safely.',
        {
          code: 'ISOLATED_SESSION_DELETE_REQUIRES_SAFE_ARCHIVE',
          statusCode: 409,
        },
      );
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk) {
      // Every file the conversation has lived in, not just the one the row
      // points at now: editing a message on a provider that rewinds by
      // branching moves the session onto a copy and leaves the earlier
      // transcript behind.  Validate each path immediately before unlinking;
      // a database path or superseded-path record is not a filesystem trust
      // boundary.  Records that lack a valid provider id/metadata are skipped
      // deliberately rather than risking deletion outside the provider root.
      const transcripts: Array<{
        provider: LLMProvider;
        providerSessionId: string;
        path: string;
      }> = [];
      if (session.jsonl_path && session.provider_session_id) {
        transcripts.push({
          provider: session.provider as LLMProvider,
          providerSessionId: session.provider_session_id,
          path: session.jsonl_path,
        });
      }

      for (const record of sessionsDb.getSupersededTranscriptRecords(sessionId)) {
        if (record.provider !== 'claude' && record.provider !== 'codex') {
          continue;
        }
        transcripts.push({
          provider: record.provider,
          providerSessionId: record.provider_session_id,
          path: record.jsonl_path,
        });
      }

      for (const transcript of transcripts) {
        const canonicalPath = await resolveCanonicalSessionTranscriptPath(
          transcript.provider,
          transcript.path,
          transcript.providerSessionId,
        );
        if (!canonicalPath) {
          continue;
        }
        removedFromDisk = (await removeFileIfExists(canonicalPath)) || removedFromDisk;
      }
    }

    sessionsDb.clearSupersededProviderSessions(sessionId);
    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
