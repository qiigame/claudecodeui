import { getConnection } from '@/modules/database/connection.js';
import type {
  SessionWorkspaceRepositoryRecord,
  SessionWorkspaceSummary,
} from '@/shared/types.js';

type CreateSessionWorkspaceRecord = {
  sessionId: string;
  sourceProjectId: string;
  sourceProjectPath: string;
  workspaceProjectId: string;
  workspacePath: string;
  branchPrefix: string;
  createdByUserId: number;
  repositories: SessionWorkspaceRepositoryRecord[];
};

type SessionWorkspaceRow = {
  session_id: string;
  workspace_project_id: string;
  workspace_path: string;
  branch_prefix: string;
};

type SessionWorkspaceRepositoryRow = {
  session_id: string;
  repository_key: string;
  source_path: string;
  worktree_path: string;
  branch_name: string;
  remote_name: string;
  base_branch: string;
  base_sha: string;
};

function mapRepositoryRow(row: SessionWorkspaceRepositoryRow): SessionWorkspaceRepositoryRecord {
  return {
    repositoryKey: row.repository_key,
    sourcePath: row.source_path,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    remoteName: row.remote_name,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
  };
}

/** Database access used by Providers and Projects to persist and display isolated session workspaces. */
export const sessionWorkspacesDb = {
  create(input: CreateSessionWorkspaceRecord): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO session_workspaces (
          session_id,
          source_project_id,
          source_project_path,
          workspace_project_id,
          workspace_path,
          branch_prefix,
          created_by_user_id,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(
        input.sessionId,
        input.sourceProjectId,
        input.sourceProjectPath,
        input.workspaceProjectId,
        input.workspacePath,
        input.branchPrefix,
        input.createdByUserId,
      );

      const insertRepository = db.prepare(`
        INSERT INTO session_workspace_repositories (
          session_id,
          repository_key,
          source_path,
          worktree_path,
          branch_name,
          remote_name,
          base_branch,
          base_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const repository of input.repositories) {
        insertRepository.run(
          input.sessionId,
          repository.repositoryKey,
          repository.sourcePath,
          repository.worktreePath,
          repository.branchName,
          repository.remoteName,
          repository.baseBranch,
          repository.baseSha,
        );
      }
    })();
  },

  getBySessionId(sessionId: string): SessionWorkspaceSummary | null {
    const summaries = sessionWorkspacesDb.getBySessionIds([sessionId]);
    return summaries.get(sessionId) ?? null;
  },

  getBySessionIds(sessionIds: string[]): Map<string, SessionWorkspaceSummary> {
    if (sessionIds.length === 0) {
      return new Map();
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    const workspaceRows = db.prepare(`
      SELECT session_id, workspace_project_id, workspace_path, branch_prefix
      FROM session_workspaces
      WHERE status = 'active' AND session_id IN (${placeholders})
    `).all(...sessionIds) as SessionWorkspaceRow[];

    if (workspaceRows.length === 0) {
      return new Map();
    }

    const workspaceSessionIds = workspaceRows.map((row) => row.session_id);
    const repositoryPlaceholders = workspaceSessionIds.map(() => '?').join(', ');
    const repositoryRows = db.prepare(`
      SELECT
        session_id,
        repository_key,
        source_path,
        worktree_path,
        branch_name,
        remote_name,
        base_branch,
        base_sha
      FROM session_workspace_repositories
      WHERE session_id IN (${repositoryPlaceholders})
      ORDER BY session_id, repository_key
    `).all(...workspaceSessionIds) as SessionWorkspaceRepositoryRow[];

    const repositoriesBySession = new Map<string, SessionWorkspaceRepositoryRecord[]>();
    for (const row of repositoryRows) {
      const repositories = repositoriesBySession.get(row.session_id) ?? [];
      repositories.push(mapRepositoryRow(row));
      repositoriesBySession.set(row.session_id, repositories);
    }

    return new Map(workspaceRows.map((row) => [
      row.session_id,
      {
        projectId: row.workspace_project_id,
        path: row.workspace_path,
        branchPrefix: row.branch_prefix,
        repositories: repositoriesBySession.get(row.session_id) ?? [],
      },
    ]));
  },
};
