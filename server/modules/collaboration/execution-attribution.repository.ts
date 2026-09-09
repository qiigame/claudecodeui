import { getConnection } from '@/modules/database/index.js';
import type {
  CommitReceiptInsert,
  CommitReceiptSummary,
  ExecutionRunRecord,
} from '@/shared/types.js';

type ExecutionRunRow = {
  run_id: string;
  session_id: string | null;
  actor_id: number;
  person_id: string | null;
  identity_status: 'verified' | 'configured' | 'pending' | 'ambiguous' | 'legacy';
  provider: string;
  project_path: string;
  expected_git_name: string;
  expected_git_email: string | null;
  git_identity_mode: 'personal' | 'shared' | 'unknown';
  status: string;
  started_at: string;
  completed_at: string | null;
};

type CommitReceiptRow = {
  receipt_id: number;
  commit_sha: string;
  repo_path: string;
  run_id: string;
  session_id: string | null;
  actor_id: number;
  human_actor: string | null;
  task_id: string | null;
  provider: string;
  author_name: string;
  author_email: string;
  committer_name: string;
  committer_email: string;
  verification_status: string;
  committed_at: string;
  recorded_at: string;
};

type CommitReceiptWithoutActor = Omit<CommitReceiptSummary, 'actor'> & {
  actorId: number;
};

const executionRunRecord = (row: ExecutionRunRow): ExecutionRunRecord => ({
  runId: row.run_id,
  sessionId: row.session_id,
  actorId: row.actor_id,
  personId: row.person_id,
  identityStatus: row.identity_status,
  provider: row.provider,
  projectPath: row.project_path,
  expectedGitName: row.expected_git_name,
  expectedGitEmail: row.expected_git_email,
  gitIdentityMode: row.git_identity_mode,
  status: row.status,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

const receiptWithoutActor = (row: CommitReceiptRow): CommitReceiptWithoutActor => ({
  receiptId: row.receipt_id,
  commitSha: row.commit_sha,
  repoPath: row.repo_path,
  runId: row.run_id,
  sessionId: row.session_id,
  actorId: row.actor_id,
  humanActor: row.human_actor,
  taskId: row.task_id,
  provider: row.provider,
  authorName: row.author_name,
  authorEmail: row.author_email,
  committerName: row.committer_name,
  committerEmail: row.committer_email,
  verificationStatus: row.verification_status,
  committedAt: row.committed_at,
  recordedAt: row.recorded_at,
});

const COMMIT_RECEIPT_SELECT = `
  SELECT
    receipt_id, commit_sha, repo_path, run_id, session_id, actor_id, human_actor, task_id,
    provider, author_name, author_email, committer_name, committer_email,
    verification_status, committed_at, recorded_at
  FROM commit_receipts
`;

/**
 * Persistence used only by the Collaboration module's execution-attribution
 * service. Receipt tokens are stored as hashes and are never returned from
 * repository reads.
 */
export const executionAttributionRepository = {
  createExecutionRun(run: ExecutionRunRecord, receiptTokenHash: string): void {
    getConnection().prepare(`
      INSERT INTO execution_runs (
        run_id, session_id, actor_id, person_id, identity_status, provider, project_path,
        expected_git_name, expected_git_email, git_identity_mode, receipt_token_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
    `).run(
      run.runId,
      run.sessionId,
      run.actorId,
      run.personId,
      run.identityStatus,
      run.provider,
      run.projectPath,
      run.expectedGitName,
      run.expectedGitEmail,
      run.gitIdentityMode,
      receiptTokenHash,
    );
  },

  getExecutionRunByTokenHash(receiptTokenHash: string): ExecutionRunRecord | null {
    const row = getConnection().prepare(`
      SELECT
        run_id, session_id, actor_id, person_id, identity_status, provider, project_path,
        expected_git_name, expected_git_email, git_identity_mode, status, started_at, completed_at
      FROM execution_runs
      WHERE receipt_token_hash = ?
    `).get(receiptTokenHash) as ExecutionRunRow | undefined;
    return row ? executionRunRecord(row) : null;
  },

  completeExecutionRun(runId: string, status: 'succeeded' | 'failed'): void {
    getConnection().prepare(`
      UPDATE execution_runs
      SET status = ?, completed_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status = 'running'
    `).run(status, runId);
  },

  insertCommitReceipt(input: CommitReceiptInsert): CommitReceiptWithoutActor {
    const db = getConnection();
    db.prepare(`
      INSERT INTO commit_receipts (
        commit_sha, repo_path, run_id, session_id, actor_id, human_actor, task_id, provider,
        author_name, author_email, committer_name, committer_email,
        verification_status, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, repo_path, commit_sha) DO NOTHING
    `).run(
      input.commitSha,
      input.repoPath,
      input.runId,
      input.sessionId,
      input.actorId,
      input.humanActor,
      input.taskId,
      input.provider,
      input.authorName,
      input.authorEmail,
      input.committerName,
      input.committerEmail,
      input.verificationStatus,
      input.committedAt,
    );

    const row = db.prepare(`
      ${COMMIT_RECEIPT_SELECT}
      WHERE run_id = ? AND repo_path = ? AND commit_sha = ?
    `).get(input.runId, input.repoPath, input.commitSha) as CommitReceiptRow | undefined;
    if (!row) {
      throw new Error('Commit receipt write could not be read back.');
    }
    return receiptWithoutActor(row);
  },

  listCommitReceipts(input: {
    sessionId?: string;
    taskId?: string;
    limit: number;
  }): CommitReceiptWithoutActor[] {
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.sessionId) {
      filters.push('session_id = ?');
      parameters.push(input.sessionId);
    }
    if (input.taskId) {
      filters.push('task_id = ?');
      parameters.push(input.taskId);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    parameters.push(input.limit);

    const rows = getConnection().prepare(`
      ${COMMIT_RECEIPT_SELECT}
      ${whereClause}
      ORDER BY receipt_id DESC
      LIMIT ?
    `).all(...parameters) as CommitReceiptRow[];
    return rows.map(receiptWithoutActor);
  },
};
