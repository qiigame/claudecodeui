import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  findFilesRecursivelyCreatedAfter,
  normalizeProjectPath,
  normalizeSessionName,
  preflightProviderTranscriptPath,
  closeProviderTranscriptReadHandle,
  openProviderTranscriptReadHandle,
  readFirstJsonlRecordFromHandle,
  readObjectRecord,
  readFileTimestamps,
  resolveCodexHomeDirectory,
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

type CodexSessionMetadata = {
  sessionId: string;
  projectPath: string;
  isSubagent: boolean;
};

type CodexSessionSynchronizerDependencies = {
  getCodexHomeDirectory: () => string;
  preflightTranscriptPath: (
    input: ProviderTranscriptPathPreflightInput,
  ) => Promise<ProviderTranscriptPathPreflightResult | null>;
  validateTranscriptRecord: (
    input: ProviderTranscriptRecordValidationInput,
  ) => boolean;
};

const defaultDependencies: CodexSessionSynchronizerDependencies = {
  getCodexHomeDirectory: resolveCodexHomeDirectory,
  preflightTranscriptPath: preflightProviderTranscriptPath,
  validateTranscriptRecord: validateProviderTranscriptRecord,
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly dependencies: CodexSessionSynchronizerDependencies;

  constructor(dependencyOverrides: Partial<CodexSessionSynchronizerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides };
  }

  /**
   * Scans the configured Codex home sessions tree and upserts discovered
   * sessions into DB. The path is resolved per call so an isolated CloudCLI
   * instance never falls back to the host user's unrelated rollouts.
   */
  async synchronize(since?: Date): Promise<number> {
    const codexHome = this.dependencies.getCodexHomeDirectory();
    const nameMap = await buildLookupMap(path.join(codexHome, 'session_index.jsonl'), 'id', 'thread_name');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
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

      const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId, this.provider)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      if (existingSession) {
        // If session name is untitled and we now have a name, update it
        if (existingSession.custom_name === 'Untitled Codex Session' && parsed.sessionName && parsed.sessionName !== 'Untitled Codex Session') {
          sessionsDb.updateSessionCustomName(existingSession.session_id, parsed.sessionName);
        }
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
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const validated = await this.validateSessionFile(filePath);
    if (!validated) {
      return null;
    }

    const codexHome = this.dependencies.getCodexHomeDirectory();
    const nameMap = await buildLookupMap(path.join(codexHome, 'session_index.jsonl'), 'id', 'thread_name');
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
    metadata: CodexSessionMetadata;
    identity: { device: number; inode: number };
  } | null> {
    const homeDirectory = this.dependencies.getCodexHomeDirectory();
    const preflight = await this.dependencies.preflightTranscriptPath({
      provider: this.provider,
      candidatePath: filePath,
      rootPath: path.join(homeDirectory, 'sessions'),
    });
    if (!preflight) {
      return null;
    }

    // Establish root containment, symlink policy, regular-file type, and
    // filename shape before inspecting any provider-controlled JSONL bytes.
    // Read exactly the first non-empty envelope. Do not scan forward for a
    // later session_meta row: a foreign or malformed first row is not an
    // authenticated Codex transcript for this candidate path.
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
      const payload = data?.type === 'session_meta'
        ? readObjectRecord(data.payload)
        : null;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
      const metadata = sessionId && projectPath
        ? {
          sessionId,
          projectPath,
          isSubagent: this.isSubagentSessionMeta(payload),
        }
        : null;
      if (!metadata || metadata.isSubagent) {
        return null;
      }

      // Bind the native id and thread kind to the exact preflight result while
      // the authenticated descriptor is still open.
      if (!this.dependencies.validateTranscriptRecord({
        provider: this.provider,
        preflight,
        firstRecord,
        providerSessionId: metadata.sessionId,
        expectedSubagent: false,
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
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>,
    metadata: CodexSessionMetadata,
    identity: { device: number; inode: number },
  ): Promise<ParsedSession | null> {
    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(metadata.sessionId, this.provider)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const appIdSession = sessionsDb.getSessionById(metadata.sessionId);
    // Provider-native ids are scoped, but the app id is global. Do not use a
    // Claude/OpenCode app row that happens to share this Codex id; SQLite's
    // provider-guarded upsert would otherwise no-op and lose the transcript.
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
      // Codex stores all rollouts in date directories, so cwd is the only
      // provider-native binding available for an already-indexed app row.
      return null;
    }
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        sessionId: metadata.sessionId,
        projectPath: metadata.projectPath,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = nameMap.get(metadata.sessionId);
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath, identity);
    }

    return {
      sessionId: metadata.sessionId,
      projectPath: metadata.projectPath,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(
    filePath: string,
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
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
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
