import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildClaudeTranscriptFilePath,
  buildLookupMap,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  normalizeProjectPath,
  readObjectRecord,
  closeProviderTranscriptReadHandle,
  openProviderTranscriptReadHandle,
  readFirstJsonlRecordFromHandle,
  readFileTimestamps,
  preflightProviderTranscriptPath,
  resolveClaudeConfigDirectory,
  type ProviderTranscriptRecordValidationInput,
  type ProviderTranscriptPathPreflightInput,
  type ProviderTranscriptPathPreflightResult,
  validateProviderTranscriptRecord,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

type ClaudeSessionMetadata = {
  sessionId: string;
  projectPath: string;
};

type ClaudeSessionSynchronizerDependencies = {
  getClaudeConfigDirectory: () => string;
  preflightTranscriptPath: (
    input: ProviderTranscriptPathPreflightInput,
  ) => Promise<ProviderTranscriptPathPreflightResult | null>;
  validateTranscriptRecord: (
    input: ProviderTranscriptRecordValidationInput,
  ) => boolean;
};

const defaultDependencies: ClaudeSessionSynchronizerDependencies = {
  getClaudeConfigDirectory: resolveClaudeConfigDirectory,
  preflightTranscriptPath: preflightProviderTranscriptPath,
  validateTranscriptRecord: validateProviderTranscriptRecord,
};

/**
 * Used by ClaudeProvider and the providers synchronization service to index
 * Claude transcript artifacts from the same configuration root as the runtime.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly dependencies: ClaudeSessionSynchronizerDependencies;

  constructor(dependencyOverrides: Partial<ClaudeSessionSynchronizerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides };
  }

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans the active Claude configuration root and upserts discovered sessions
   * into the database.
   */
  async synchronize(since?: Date): Promise<number> {
    const claudeHome = this.dependencies.getClaudeConfigDirectory();
    const nameMap = await buildLookupMap(path.join(claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const incrementallyDiscoveredFiles = await findFilesRecursivelyCreatedAfter(
      path.join(claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    // The scan cursor may have advanced while an earlier build watched the
    // wrong Claude root. Recover mapped app sessions with no transcript path
    // regardless of file age, otherwise their already-existing JSONL files
    // would stay invisible until Claude happened to write to them again.
    // Only active rows participate: createSession intentionally marks an
    // indexed artifact active, so recovering archived rows here would silently
    // unarchive conversations the user chose to hide.
    const missingPathCandidates = sessionsDb.getAllSessions()
      .filter((session) => (
        session.provider === this.provider
        && !session.jsonl_path
        && Boolean(session.project_path)
        && Boolean(session.provider_session_id)
      ))
      .map((session) => buildClaudeTranscriptFilePath(
        claudeHome,
        session.project_path ?? '',
        session.provider_session_id ?? '',
      ))
      .filter((candidate): candidate is string => Boolean(candidate));
    const files = [...new Set([...incrementallyDiscoveredFiles, ...missingPathCandidates])];

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const validated = await this.validateSessionFile(filePath);
      if (!validated) {
        continue;
      }

      const parsed = await this.processSessionFile(
        validated.canonicalPath,
        nameMap,
        validated.metadata,
        validated.identity,
      );
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(
        validated.canonicalPath,
        validated.identity,
      );
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        validated.canonicalPath,
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const validated = await this.validateSessionFile(filePath);
    if (!validated) {
      return null;
    }

    const nameMap = await buildLookupMap(
      path.join(this.dependencies.getClaudeConfigDirectory(), 'history.jsonl'),
      'sessionId',
      'display',
    );
    const parsed = await this.processSessionFile(
      validated.canonicalPath,
      nameMap,
      validated.metadata,
      validated.identity,
    );
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(
      validated.canonicalPath,
      validated.identity,
    );
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      validated.canonicalPath,
    );
  }

  /**
   * Authenticates a candidate before any title/timestamp/database work. The
   * returned path is canonical and is the only path later consumers may use.
   */
  private async validateSessionFile(filePath: string): Promise<{
    canonicalPath: string;
    metadata: ClaudeSessionMetadata;
    identity: { device: number; inode: number };
  } | null> {
    const configDirectory = this.dependencies.getClaudeConfigDirectory();
    const preflight = await this.dependencies.preflightTranscriptPath({
      provider: this.provider,
      candidatePath: filePath,
      rootPath: path.join(configDirectory, 'projects'),
    });
    if (!preflight) {
      return null;
    }

    // The path and file type have already been authenticated.  Only now may
    // the synchronizer inspect the first JSONL envelope for provider metadata.
    // Read exactly the first non-empty envelope. Do not scan forward for a
    // later row that happens to look like a session header: a foreign or
    // malformed first row must fail closed before any indexing side effect.
    const opened = await openProviderTranscriptReadHandle(preflight.canonicalPath, {
      device: preflight.device,
      inode: preflight.inode,
    });
    if (!opened) {
      return null;
    }
    try {
      const firstRecord = await readFirstJsonlRecordFromHandle(opened.handle);
      const data = readObjectRecord(firstRecord);
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data?.cwd === 'string' ? data.cwd : undefined;
      const metadata = sessionId && projectPath
        ? { sessionId, projectPath }
        : null;
      if (!metadata) {
        return null;
      }

      // Bind the native id and Claude's encoded cwd directory to the exact
      // preflight result while the authenticated descriptor is still open.
      if (!this.dependencies.validateTranscriptRecord({
        provider: this.provider,
        preflight,
        firstRecord,
        providerSessionId: metadata.sessionId,
      })) {
        return null;
      }

      return {
        canonicalPath: preflight.canonicalPath,
        metadata,
        identity: { device: opened.device, inode: opened.inode },
      };
    } finally {
      await closeProviderTranscriptReadHandle(opened.handle);
    }
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>,
    metadata: ClaudeSessionMetadata,
    identity: { device: number; inode: number },
  ): Promise<ParsedSession | null> {
    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const appIdSession = sessionsDb.getSessionById(metadata.sessionId);
    // The app id is globally unique while provider-native ids are scoped. A
    // Claude native id may therefore collide with another provider's app id;
    // never borrow that row's title or let the later upsert silently no-op.
    const existingSession = sessionsDb.getSessionByProviderSessionId(metadata.sessionId, this.provider)
      ?? (appIdSession?.provider === this.provider ? appIdSession : null);
    if (appIdSession && appIdSession.provider !== this.provider && !existingSession) {
      return null;
    }
    const expectedProjectPath = existingSession?.runtime_path ?? existingSession?.project_path;
    if (
      expectedProjectPath
      && normalizeProjectPath(expectedProjectPath) !== normalizeProjectPath(metadata.projectPath)
    ) {
      // A provider id is scoped, but its cwd is still part of the session
      // identity.  Do not let a stale/malicious transcript move an existing
      // app row to a different checkout.
      return null;
    }
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...metadata,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    let sessionName = nameMap.get(metadata.sessionId);
    if (!sessionName) {
      sessionName = await this.extractSessionAiTitleFromEnd(filePath, metadata.sessionId, identity);
    }

    return {
      ...metadata,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string,
    identity: { device: number; inode: number },
  ): Promise<string | undefined> {
    const opened = await openProviderTranscriptReadHandle(filePath, identity);
    if (!opened) {
      return undefined;
    }
    try {
      const content = await opened.handle.readFile({ encoding: 'utf8' });
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (
          (eventType === 'ai-title' && eventSessionId === sessionId && aiTitle?.trim()) ||
          (eventType === 'last-prompt' && eventSessionId === sessionId && lastPrompt?.trim()) ||
          (eventType === "custom-title" && eventSessionId === sessionId && claudeRenamedTitle?.trim())
        ) {
          return aiTitle || lastPrompt || claudeRenamedTitle;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    } finally {
      await closeProviderTranscriptReadHandle(opened.handle);
    }

    return undefined;
  }
}
