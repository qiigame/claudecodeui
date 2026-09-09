import { promises as fs } from 'node:fs';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  AppError,
  resolveClaudeConfigDirectory,
  resolveCodexHomeDirectory,
  validateProviderTranscriptPath,
} from '@/shared/utils.js';

type TranscriptPathRow = {
  provider?: unknown;
  provider_session_id?: unknown;
  jsonl_path?: unknown;
};

type TranscriptPathCandidate = {
  provider: string;
  providerSessionId: string;
  candidatePath: string;
};

function uniqueJsonlPathsFromSessions(
  sessions: TranscriptPathRow[],
): TranscriptPathCandidate[] {
  const seen = new Set<string>();
  const result: TranscriptPathCandidate[] = [];

  for (const row of sessions) {
    const raw = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
    const providerSessionId = typeof row.provider_session_id === 'string'
      ? row.provider_session_id.trim()
      : '';
    // A transcript cannot be authenticated without its provider-native id.
    if (!raw || !provider || !providerSessionId) {
      continue;
    }
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
    const key = `${provider}\0${providerSessionId}\0${absolute}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ provider, providerSessionId, candidatePath: absolute });
  }

  return result;
}

function providerTranscriptRoot(provider: string): string | null {
  if (provider === 'claude') {
    return path.join(resolveClaudeConfigDirectory(), 'projects');
  }
  if (provider === 'codex') {
    return path.join(resolveCodexHomeDirectory(), 'sessions');
  }
  return null;
}

async function validateTranscriptForDeletion(
  candidate: TranscriptPathCandidate,
): Promise<string | null> {
  const rootPath = providerTranscriptRoot(candidate.provider);
  if (!rootPath || (candidate.provider !== 'claude' && candidate.provider !== 'codex')) {
    return null;
  }

  return validateProviderTranscriptPath({
    provider: candidate.provider,
    candidatePath: candidate.candidatePath,
    rootPath,
    providerSessionId: candidate.providerSessionId,
  });
}

async function unlinkJsonlIfExists(filePath: string): Promise<void> {
  try {
    const fileStat = await fs.lstat(filePath);
    if (!fileStat.isFile()) {
      return;
    }
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    console.warn(`[project-delete] Failed to remove ${filePath}:`, (error as Error).message);
  }
}

/**
 * Loads all session rows for the project path and removes only provider-validated
 * transcript files. Unknown providers, missing native ids, malformed metadata,
 * symlinks, and paths outside the provider roots are intentionally skipped.
 */
export async function deleteSessionJsonlFilesForProjectPath(projectPath: string): Promise<void> {
  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
  // Including the transcripts a session has left behind: editing a message on
  // a provider that rewinds by branching moves the session onto a copy, and
  // the row stops pointing at the file the replaced turns are still in.
  const candidates = uniqueJsonlPathsFromSessions([
    ...sessions,
    ...sessions.flatMap((session) => sessionsDb
      .getSupersededTranscriptRecords(session.session_id)),
  ]);

  const removedCanonicalPaths = new Set<string>();
  for (const candidate of candidates) {
    const canonicalPath = await validateTranscriptForDeletion(candidate);
    if (!canonicalPath || removedCanonicalPaths.has(canonicalPath)) {
      continue;
    }
    removedCanonicalPaths.add(canonicalPath);
    await unlinkJsonlIfExists(canonicalPath);
  }

  for (const session of sessions) {
    sessionsDb.clearSupersededProviderSessions(session.session_id);
  }
}

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): remove validated Claude/Codex transcript files,
 *   then remove session rows and the `projects` row.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    return;
  }

  await deleteSessionJsonlFilesForProjectPath(row.project_path);
  sessionsDb.deleteSessionsByProjectPath(row.project_path);
  projectsDb.deleteProjectById(projectId);
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
}
