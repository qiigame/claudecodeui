import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  CommitReceiptSummary,
  ExecutionAttributionContext,
} from '@/shared/types.js';
import { AppError, isValidEmailAddress } from '@/shared/utils.js';

import { collaborationRepository } from './collaboration.repository.js';
import { ensureCommitAttributionHooks } from './commit-attribution-hooks.service.js';
import { executionAttributionRepository } from './execution-attribution.repository.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

type InspectedCommit = {
  commitSha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  message: string;
};

type ExecutionAttributionDependencies = {
  ensureHooks(): string;
  inspectCommit(repoPath: string, commitSha: string): Promise<InspectedCommit>;
};

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

function readTrailer(message: string, key: string): string | null {
  const prefix = `${key}:`;
  const matchingLine = message
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(prefix));
  return matchingLine?.slice(prefix.length).trim() || null;
}

function isContainedPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRepoWithinExecutionScope(projectPath: string, repoPath: string): boolean {
  // The execution scope is the server-owned workspace root supplied when the
  // run was admitted. A submitted repository may be that root or one of its
  // descendants; allowing the inverse relation would let a session opened in
  // a nested directory submit a commit from an arbitrary parent repository.
  return isContainedPath(projectPath, repoPath);
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    throw new AppError('The submitted commit could not be inspected.', {
      code: 'COMMIT_INSPECTION_FAILED',
      statusCode: 400,
    });
  }
}

async function inspectGitCommit(repoPathInput: string, commitShaInput: string): Promise<InspectedCommit> {
  if (!COMMIT_SHA_PATTERN.test(commitShaInput)) {
    throw new AppError('A full Git commit SHA is required.', {
      code: 'INVALID_COMMIT_SHA',
      statusCode: 400,
    });
  }

  const commitSha = await runGit(repoPathInput, [
    'rev-parse',
    '--verify',
    `${commitShaInput}^{commit}`,
  ]);
  const output = await runGit(repoPathInput, [
    'show',
    '-s',
    '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%cI%x00%B',
    commitSha,
  ]);
  const [resolvedSha, authorName, authorEmail, committerName, committerEmail, committedAt, ...message] =
    output.split('\0');
  if (!resolvedSha || !authorName || !authorEmail || !committerName || !committerEmail || !committedAt) {
    throw new AppError('Git returned incomplete commit metadata.', {
      code: 'COMMIT_METADATA_INCOMPLETE',
      statusCode: 400,
    });
  }

  return {
    commitSha: resolvedSha,
    authorName,
    authorEmail,
    committerName,
    committerEmail,
    committedAt,
    message: message.join('\0'),
  };
}

const defaultDependencies: ExecutionAttributionDependencies = {
  ensureHooks: ensureCommitAttributionHooks,
  inspectCommit: inspectGitCommit,
};

function receiptEndpointUrl(): string {
  const port = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('SERVER_PORT is invalid for commit attribution.');
  }
  const configuredHost = process.env.HOST?.trim() || '127.0.0.1';
  const host = configuredHost === '0.0.0.0' || configuredHost === '::'
    ? '127.0.0.1'
    : configuredHost;
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) {
    throw new Error('HOST is invalid for commit attribution.');
  }
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/api/internal/commit-receipts`;
}

function buildExecutionEnvironment(input: {
  actorId: number;
  sessionId: string | null;
  runId: string;
  provider: string;
  gitName: string;
  gitEmail: string | null;
  personId: string | null;
  identityStatus: 'verified' | 'configured' | 'pending' | 'ambiguous' | 'legacy';
  gitIdentityMode: 'personal' | 'shared' | 'unknown';
  hooksDirectory: string;
  receiptToken: string;
}): Record<string, string> {
  const gitIdentityReady = Boolean(input.gitEmail && isValidEmailAddress(input.gitEmail))
    && (input.gitIdentityMode !== 'shared' || input.identityStatus === 'verified');
  const environment: Record<string, string> = {
    CLOUDCLI_ACTOR_ID: String(input.actorId),
    CLOUDCLI_EXECUTION_RUN_ID: input.runId,
    CLOUDCLI_PROVIDER: input.provider,
    CLOUDCLI_GIT_IDENTITY_READY: gitIdentityReady ? '1' : '0',
    CLOUDCLI_GIT_IDENTITY_SHARED: input.gitIdentityMode === 'shared' ? '1' : '0',
    CLOUDCLI_IDENTITY_STATUS: input.identityStatus,
    CLOUDCLI_COMMIT_RECEIPT_URL: receiptEndpointUrl(),
    CLOUDCLI_COMMIT_RECEIPT_TOKEN: input.receiptToken,
    GIT_CONFIG_COUNT: gitIdentityReady ? '3' : '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: input.hooksDirectory,
  };
  if (input.sessionId) {
    environment.CLOUDCLI_SESSION_ID = input.sessionId;
  }
  if (input.personId) {
    environment.CLOUDCLI_PERSON_ID = input.personId;
    environment.CLOUDCLI_HUMAN_ACTOR_REQUIRED = '1';
  }
  if (gitIdentityReady && input.gitEmail) {
    environment.GIT_CONFIG_KEY_1 = 'user.name';
    environment.GIT_CONFIG_VALUE_1 = input.gitName;
    environment.GIT_CONFIG_KEY_2 = 'user.email';
    environment.GIT_CONFIG_VALUE_2 = input.gitEmail;
    environment.GIT_AUTHOR_NAME = input.gitName;
    environment.GIT_AUTHOR_EMAIL = input.gitEmail;
    environment.GIT_COMMITTER_NAME = input.gitName;
    environment.GIT_COMMITTER_EMAIL = input.gitEmail;
  }
  return environment;
}

/**
 * Creates execution-scoped identity environments and validates commit receipts
 * for the WebSocket and internal-hook routes. Exported factory supports focused
 * tests without invoking Git or writing hooks.
 */
export function createExecutionAttributionService(
  dependencyOverrides: Partial<ExecutionAttributionDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    beginExecution(input: {
      userId: string | number | null | undefined;
      sessionId: string | null;
      provider: string;
      projectPath: string;
      /** Read-only chat records attribution but leaves shared Git commits blocked. */
      requireVerifiedIdentity?: boolean;
    }): ExecutionAttributionContext {
      const userId = typeof input.userId === 'number' ? input.userId : Number(input.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new AppError('Authenticated user is required for execution attribution.', {
          code: 'EXECUTION_USER_REQUIRED',
          statusCode: 401,
        });
      }

      const projectPath = fs.realpathSync(path.resolve(input.projectPath));
      const identity = collaborationRepository.getExecutionActorIdentity(userId, {
        requireVerifiedIdentity: input.requireVerifiedIdentity,
      });
      const gitEmail = identity.gitEmail && isValidEmailAddress(identity.gitEmail)
        ? identity.gitEmail
        : null;
      const gitIdentityReady = Boolean(gitEmail)
        && (identity.gitIdentityMode !== 'shared' || identity.identityStatus === 'verified');
      const runId = randomUUID();
      const receiptToken = randomBytes(32).toString('base64url');
      const hooksDirectory = dependencies.ensureHooks();
      const environment = buildExecutionEnvironment({
        actorId: identity.actor.actorId,
        sessionId: input.sessionId,
        runId,
        provider: input.provider,
        gitName: identity.gitName,
        gitEmail,
        personId: identity.personId,
        identityStatus: identity.identityStatus,
        gitIdentityMode: identity.gitIdentityMode,
        hooksDirectory,
        receiptToken,
      });

      executionAttributionRepository.createExecutionRun({
        runId,
        sessionId: input.sessionId,
        actorId: identity.actor.actorId,
        personId: identity.personId,
        identityStatus: identity.identityStatus,
        provider: input.provider,
        projectPath,
        expectedGitName: identity.gitName,
        expectedGitEmail: gitEmail,
        gitIdentityMode: identity.gitIdentityMode,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
      }, hashToken(receiptToken));

      return {
        runId,
        actor: identity.actor,
        sessionId: input.sessionId,
        provider: input.provider,
        projectPath,
        gitIdentityReady,
        gitName: identity.gitName,
        gitEmail,
        personId: identity.personId,
        gitIdentityMode: identity.gitIdentityMode,
        environment,
      };
    },

    completeExecution(runId: string, status: 'succeeded' | 'failed'): void {
      executionAttributionRepository.completeExecutionRun(runId, status);
    },

    async recordCommitReceipt(input: {
      receiptToken: string;
      runId: string;
      repoPath: string;
      commitSha: string;
    }): Promise<CommitReceiptSummary> {
      const run = executionAttributionRepository.getExecutionRunByTokenHash(
        hashToken(input.receiptToken),
      );
      if (!run || run.runId !== input.runId || run.status !== 'running') {
        throw new AppError('The execution receipt token is invalid or expired.', {
          code: 'INVALID_EXECUTION_RECEIPT_TOKEN',
          statusCode: 401,
        });
      }

      const requestedRepoPath = path.resolve(input.repoPath);
      const repoPath = path.resolve(await runGit(requestedRepoPath, ['rev-parse', '--show-toplevel']));
      if (!isRepoWithinExecutionScope(run.projectPath, repoPath)) {
        throw new AppError('The repository is outside this execution scope.', {
          code: 'COMMIT_REPOSITORY_OUT_OF_SCOPE',
          statusCode: 403,
        });
      }

      const commit = await dependencies.inspectCommit(repoPath, input.commitSha);
      const expectedEmail = run.expectedGitEmail?.toLowerCase() ?? null;
      const humanActor = readTrailer(commit.message, 'Human-Actor');
      const identityMatches = Boolean(
        expectedEmail
        && commit.authorName === run.expectedGitName
        && commit.committerName === run.expectedGitName
        && commit.authorEmail.toLowerCase() === expectedEmail
        && commit.committerEmail.toLowerCase() === expectedEmail,
      );
      const metadataMatches =
        readTrailer(commit.message, 'CloudCLI-Actor-ID') === String(run.actorId)
        && readTrailer(commit.message, 'CloudCLI-Run-ID') === run.runId
        && readTrailer(commit.message, 'CloudCLI-Provider') === run.provider
        && (
          run.sessionId === null
          || readTrailer(commit.message, 'CloudCLI-Session-ID') === run.sessionId
        )
        && (
          run.personId === null
          || humanActor === run.personId
        );
      const verificationStatus = !run.expectedGitEmail
        ? 'git_identity_missing'
        : run.personId && !humanActor
          ? 'human_actor_missing'
          : run.personId && humanActor !== run.personId
            ? 'human_actor_mismatch'
        : identityMatches && metadataMatches
          ? 'verified'
          : identityMatches
            ? 'metadata_mismatch'
            : metadataMatches
              ? 'identity_mismatch'
              : 'identity_and_metadata_mismatch';
      const taskId = readTrailer(commit.message, 'Agent-Task')?.slice(0, 128) ?? null;

      const receipt = executionAttributionRepository.insertCommitReceipt({
        commitSha: commit.commitSha,
        repoPath,
        runId: run.runId,
        sessionId: run.sessionId,
        actorId: run.actorId,
        humanActor,
        taskId,
        provider: run.provider,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        committerName: commit.committerName,
        committerEmail: commit.committerEmail,
        verificationStatus,
        committedAt: commit.committedAt,
      });
      const actor = collaborationRepository.getActorById(receipt.actorId);
      if (!actor) {
        throw new Error('Commit receipt actor was not found.');
      }
      const { actorId: _actorId, ...summary } = receipt;
      return { ...summary, actor };
    },

    listCommitReceipts(input: {
      sessionId?: string;
      taskId?: string;
      limit?: number;
    }): CommitReceiptSummary[] {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      return executionAttributionRepository.listCommitReceipts({
        sessionId: input.sessionId,
        taskId: input.taskId,
        limit,
      }).map((receipt) => {
        const actor = collaborationRepository.getActorById(receipt.actorId);
        if (!actor) {
          throw new Error('Commit receipt actor was not found.');
        }
        const { actorId: _actorId, ...summary } = receipt;
        return { ...summary, actor };
      });
    },
  };
}

/** Used by WebSocket runtimes and collaboration routes for trusted attribution. */
export const executionAttributionService = createExecutionAttributionService();
