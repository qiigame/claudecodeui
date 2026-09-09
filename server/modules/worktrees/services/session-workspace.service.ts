import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  ProvisionSessionWorkspaceInput,
  ProvisionSessionWorkspaceResult,
  SessionWorkspacePlan,
  SessionWorkspaceRepositoryRecord,
  SessionWorkspaceService,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';
import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import {
  runGitCommand,
  validateWorktreeBranchName,
} from '@/modules/worktrees/services/worktree-git.service.js';

type RepositoryPolicy = {
  key: string;
  displayName: string;
  relativePath: string;
  remoteName: string;
  baseBranch: string;
  expectedRemote: string | null;
  writable: boolean;
  unavailableReason: string | null;
};

type ProjectPolicy = {
  sourceProjectPath: string;
  defaultRepositoryKeys: string[];
  repositories: RepositoryPolicy[];
};

type SessionWorkspaceConfiguration = {
  workspaceRoot: string;
  projects: ProjectPolicy[];
};

type RawConfiguration = {
  version?: unknown;
  workspaceRoot?: unknown;
  projects?: unknown;
};

const CONFIG_ENV_NAME = 'CLOUDCLI_SESSION_WORKSPACE_CONFIG';
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 100;
const STALE_LOCK_MS = 30 * 60_000;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const POLICY_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;

/**
 * Provisioning an isolated session creates directories, fetches remotes,
 * creates Git branches/worktrees, and registers a project row in its caller.
 * Keep the complete capability set here so a future caller cannot turn an
 * otherwise read-only deployment into a writable checkout by bypassing the
 * HTTP route or Providers service guard.
 */
const SESSION_WORKSPACE_PROVISION_CAPABILITIES = [
  DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE,
  DEPLOYMENT_CAPABILITIES.FILE_WRITE,
  DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE,
  DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
] as const;

// The composition root supplies this once at startup.  Direct/standalone
// callers fall back to the trusted process environment, never browser input.
let configuredDeploymentPolicy: DeploymentPolicy | undefined;

/**
 * Pins the startup deployment policy for session-workspace provisioning.
 * Worktrees' composition root calls this when it receives the immutable
 * server policy; tests and legacy embedders may omit it and use the parsed
 * process configuration instead.
 */
export function configureSessionWorkspaceDeploymentPolicy(
  policy: DeploymentPolicy,
): void {
  configuredDeploymentPolicy = policy;
}

function resolveSessionWorkspaceDeploymentPolicy(): DeploymentPolicy {
  return configuredDeploymentPolicy ?? parseDeploymentPolicy();
}

/**
 * Rejects workspace provisioning before configuration or filesystem work.
 * Product/QA is explicitly read-only even if a caller supplies a malformed
 * capability override; all four mutation capabilities are required together.
 */
function assertSessionWorkspaceProvisioningAllowed(): void {
  const policy = resolveSessionWorkspaceDeploymentPolicy();
  const missingCapabilities = SESSION_WORKSPACE_PROVISION_CAPABILITIES.filter(
    (capability) => !hasDeploymentCapability(policy, capability),
  );

  if (isDeploymentReadOnly(policy) || missingCapabilities.length > 0) {
    throw new AppError('Creating an isolated session workspace is disabled for this deployment.', {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
      statusCode: 403,
      details: {
        profile: policy.profile,
        capability: missingCapabilities[0] ?? DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE,
        missingCapabilities,
      },
    });
  }
}

/**
 * Resolves every existing path component while preserving a not-yet-created
 * suffix.  Session workspace roots may legitimately be absent at startup, so
 * `realpathSync()` alone cannot normalize the deployment configuration.  By
 * canonicalizing the nearest existing ancestor, comparisons still cannot be
 * bypassed with a symlink alias in either the configured path or the request.
 */
function canonicalizePolicyPath(inputPath: string): string {
  const absolutePath = path.resolve(inputPath);
  const missingSegments: string[] = [];
  let existingAncestor = absolutePath;

  while (true) {
    try {
      const canonicalAncestor = fs.realpathSync(existingAncestor);
      // `realpath` fails for a path whose final component is a dangling
      // symlink.  Before retaining a missing suffix, inspect each component
      // so a later mkdir/open cannot follow that symlink outside the policy
      // root.  Existing symlink components are already resolved by realpath.
      let lexicalComponent = existingAncestor;
      for (const segment of missingSegments) {
        lexicalComponent = path.join(lexicalComponent, segment);
        try {
          if (fs.lstatSync(lexicalComponent).isSymbolicLink()) {
            throw new AppError('Configured path contains a dangling symlink.', {
              code: 'SESSION_WORKSPACE_PATH_INVALID',
              statusCode: 500,
            });
          }
        } catch (error) {
          if (error instanceof AppError) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // All later components are necessarily missing as well.
          break;
        }
      }
      return normalizeProjectPath(path.join(canonicalAncestor, ...missingSegments));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      const parentPath = path.dirname(existingAncestor);
      if (parentPath === existingAncestor) {
        throw error;
      }
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parentPath;
    }
  }
}

function configurationError(message: string): AppError {
  return new AppError(message, {
    code: 'SESSION_WORKSPACE_CONFIGURATION_INVALID',
    statusCode: 500,
  });
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw configurationError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeRelativeRepositoryPath(value: unknown, field: string): string {
  const relativePath = readNonEmptyString(value, field);
  if (path.isAbsolute(relativePath)) {
    throw configurationError(`${field} must be relative.`);
  }

  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw configurationError(`${field} must stay inside the configured project root.`);
  }
  return normalized;
}

function normalizeRemoteIdentity(value: string): string {
  return value
    .trim()
    .replace(/^ssh:\/\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^git@([^:]+):/i, '$1/')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function parseRepositoryPolicy(value: unknown, projectIndex: number, repositoryIndex: number): RepositoryPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError(`projects[${projectIndex}].repositories[${repositoryIndex}] must be an object.`);
  }

  const raw = value as Record<string, unknown>;
  const key = readNonEmptyString(raw.key, `projects[${projectIndex}].repositories[${repositoryIndex}].key`);
  if (!POLICY_KEY_PATTERN.test(key)) {
    throw configurationError(`Repository key "${key}" is invalid.`);
  }

  const writable = raw.writable !== false;
  const unavailableReason = writable
    ? null
    : typeof raw.unavailableReason === 'string' && raw.unavailableReason.trim()
      ? raw.unavailableReason.trim()
      : '该仓库在当前系统中只读';
  const remoteName = typeof raw.remoteName === 'string' && raw.remoteName.trim()
    ? raw.remoteName.trim()
    : 'origin';
  if (!POLICY_KEY_PATTERN.test(remoteName)) {
    throw configurationError(`Remote name "${remoteName}" is invalid.`);
  }
  const baseBranch = validateWorktreeBranchName(readNonEmptyString(
    raw.baseBranch,
    `projects[${projectIndex}].repositories[${repositoryIndex}].baseBranch`,
  ));

  return {
    key,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim()
      ? raw.displayName.trim()
      : key,
    relativePath: normalizeRelativeRepositoryPath(
      raw.relativePath,
      `projects[${projectIndex}].repositories[${repositoryIndex}].relativePath`,
    ),
    remoteName,
    baseBranch,
    expectedRemote: typeof raw.expectedRemote === 'string' && raw.expectedRemote.trim()
      ? normalizeRemoteIdentity(raw.expectedRemote)
      : null,
    writable,
    unavailableReason,
  };
}

function parseConfiguration(raw: RawConfiguration): SessionWorkspaceConfiguration {
  if (raw.version !== 1) {
    throw configurationError('Session workspace configuration version must be 1.');
  }

  const rawWorkspaceRoot = readNonEmptyString(raw.workspaceRoot, 'workspaceRoot');
  if (!path.isAbsolute(rawWorkspaceRoot)) {
    throw configurationError('workspaceRoot must be an absolute path.');
  }
  const workspaceRoot = canonicalizePolicyPath(rawWorkspaceRoot);
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw configurationError('projects must contain at least one configured project.');
  }

  const projects = raw.projects.map((value, projectIndex): ProjectPolicy => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw configurationError(`projects[${projectIndex}] must be an object.`);
    }

    const project = value as Record<string, unknown>;
    const sourceProjectPath = canonicalizePolicyPath(readNonEmptyString(
      project.sourceProjectPath,
      `projects[${projectIndex}].sourceProjectPath`,
    ));
    const workspaceRelativeToSource = path.relative(sourceProjectPath, workspaceRoot);
    const sourceRelativeToWorkspace = path.relative(workspaceRoot, sourceProjectPath);
    const rootsOverlap = (
      !workspaceRelativeToSource
      || (!workspaceRelativeToSource.startsWith(`..${path.sep}`) && workspaceRelativeToSource !== '..' && !path.isAbsolute(workspaceRelativeToSource))
      || (!sourceRelativeToWorkspace.startsWith(`..${path.sep}`) && sourceRelativeToWorkspace !== '..' && !path.isAbsolute(sourceRelativeToWorkspace))
    );
    if (rootsOverlap) {
      throw configurationError('workspaceRoot and sourceProjectPath must not overlap.');
    }
    if (!Array.isArray(project.repositories) || project.repositories.length === 0) {
      throw configurationError(`projects[${projectIndex}].repositories must not be empty.`);
    }

    const repositories = project.repositories.map((repository, repositoryIndex) =>
      parseRepositoryPolicy(repository, projectIndex, repositoryIndex));
    const uniqueKeys = new Set(repositories.map((repository) => repository.key));
    if (uniqueKeys.size !== repositories.length) {
      throw configurationError(`projects[${projectIndex}] contains duplicate repository keys.`);
    }

    const defaultRepositoryKeys = Array.isArray(project.defaultRepositoryKeys)
      ? project.defaultRepositoryKeys.map((key, defaultIndex) => readNonEmptyString(
        key,
        `projects[${projectIndex}].defaultRepositoryKeys[${defaultIndex}]`,
      ))
      : [];
    for (const key of defaultRepositoryKeys) {
      const repository = repositories.find((candidate) => candidate.key === key);
      if (!repository || !repository.writable) {
        throw configurationError(`Default repository "${key}" is missing or read-only.`);
      }
    }

    return { sourceProjectPath, defaultRepositoryKeys, repositories };
  });

  return { workspaceRoot, projects };
}

function loadConfiguration(): SessionWorkspaceConfiguration | null {
  const configPath = process.env[CONFIG_ENV_NAME]?.trim();
  if (!configPath) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw configurationError(`Could not read ${CONFIG_ENV_NAME}: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configurationError('Session workspace configuration must be a JSON object.');
  }
  return parseConfiguration(parsed as RawConfiguration);
}

function findProjectPolicy(
  configuration: SessionWorkspaceConfiguration,
  sourceProjectPath: string,
): { project: ProjectPolicy; selectedRepositoryKey: string | null } | null {
  const normalizedSource = canonicalizePolicyPath(sourceProjectPath);
  for (const projectPolicy of configuration.projects) {
    if (normalizeProjectPath(projectPolicy.sourceProjectPath) === normalizedSource) {
      return { project: projectPolicy, selectedRepositoryKey: null };
    }

    const matchingRepository = projectPolicy.repositories.find((repository) =>
      normalizeProjectPath(path.join(projectPolicy.sourceProjectPath, repository.relativePath)) === normalizedSource);
    if (matchingRepository) {
      return { project: projectPolicy, selectedRepositoryKey: matchingRepository.key };
    }
  }
  return null;
}

function planFromPolicy(
  project: ProjectPolicy,
  selectedRepositoryKey: string | null,
): SessionWorkspacePlan {
  const repositories = project.repositories
    .filter((repository) => !selectedRepositoryKey || repository.key === selectedRepositoryKey)
    .map((repository) => ({
      key: repository.key,
      displayName: repository.displayName,
      relativePath: repository.relativePath,
      baseBranch: repository.baseBranch,
      writable: repository.writable,
      unavailableReason: repository.unavailableReason,
    }));
  const writableKeys = repositories
    .filter((repository) => repository.writable)
    .map((repository) => repository.key);
  const configuredDefaults = selectedRepositoryKey
    ? writableKeys
    : project.defaultRepositoryKeys.filter((key) => writableKeys.includes(key));

  return {
    // `enabled` also means "managed" here. A configured all-read-only project
    // must fail closed during provisioning instead of falling back to running
    // directly in the protected source checkout.
    enabled: repositories.length > 0,
    requiresSelection: writableKeys.length > 1,
    defaultRepositoryKeys: configuredDefaults.length > 0
      ? configuredDefaults
      : writableKeys.length === 1
        ? writableKeys
        : [],
    repositories,
  };
}

function assertPathInside(parentPath: string, candidatePath: string, label: string): void {
  const relative = path.relative(parentPath, candidatePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError(`${label} must stay inside its configured parent directory.`, {
      code: 'SESSION_WORKSPACE_PATH_INVALID',
      statusCode: 500,
    });
  }
}

/**
 * Compares canonical paths at a directory boundary.  Baseline protection is
 * intentionally recursive: a project row may point at a subdirectory of a
 * protected checkout, but Git mutations from that row still alter the same
 * baseline repository.
 */
function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

async function acquireRepositoryLock(
  configuration: SessionWorkspaceConfiguration,
  repositoryPath: string,
): Promise<() => Promise<void>> {
  const { stdout } = await runGitCommand(['rev-parse', '--git-common-dir'], repositoryPath);
  const rawCommonDirectory = stdout.trim();
  const commonDirectory = path.resolve(repositoryPath, rawCommonDirectory);
  const lockKey = createHash('sha256').update(commonDirectory).digest('hex');
  const lockRoot = path.join(configuration.workspaceRoot, '.locks');
  const lockPath = path.join(lockRoot, `${lockKey}.lock`);
  await fsp.mkdir(lockRoot, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await fsp.mkdir(lockPath, { mode: 0o700 });
      return async () => {
        await fsp.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      const stats = await fsp.stat(lockPath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
        await fsp.rm(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new AppError('Another session is updating this repository. Please retry shortly.', {
          code: 'SESSION_WORKSPACE_REPOSITORY_BUSY',
          statusCode: 409,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function verifyRepositoryPolicy(
  project: ProjectPolicy,
  repository: RepositoryPolicy,
): Promise<string> {
  const configuredRepositoryPath = path.resolve(project.sourceProjectPath, repository.relativePath);
  assertPathInside(project.sourceProjectPath, configuredRepositoryPath, 'Repository path');
  const realRepositoryPath = await fsp.realpath(configuredRepositoryPath).catch(() => null);
  if (!realRepositoryPath) {
    throw new AppError(`Repository "${repository.displayName}" is unavailable.`, {
      code: 'SESSION_WORKSPACE_REPOSITORY_UNAVAILABLE',
      statusCode: 409,
    });
  }
  assertPathInside(
    project.sourceProjectPath,
    normalizeProjectPath(realRepositoryPath),
    `Repository path for "${repository.displayName}"`,
  );

  const { stdout: repositoryRootOutput } = await runGitCommand(
    ['rev-parse', '--show-toplevel'],
    realRepositoryPath,
  );
  const repositoryRoot = normalizeProjectPath(repositoryRootOutput.trim());
  if (repositoryRoot !== normalizeProjectPath(realRepositoryPath)) {
    throw new AppError(`Configured path for "${repository.displayName}" is not a repository root.`, {
      code: 'SESSION_WORKSPACE_REPOSITORY_INVALID',
      statusCode: 409,
    });
  }

  if (repository.expectedRemote) {
    const { stdout: remoteOutput } = await runGitCommand(
      ['remote', 'get-url', repository.remoteName],
      realRepositoryPath,
    );
    if (normalizeRemoteIdentity(remoteOutput) !== repository.expectedRemote) {
      throw new AppError(`Remote identity mismatch for "${repository.displayName}".`, {
        code: 'SESSION_WORKSPACE_REMOTE_MISMATCH',
        statusCode: 409,
      });
    }
  }

  return realRepositoryPath;
}

async function createRepositoryWorktree(
  configuration: SessionWorkspaceConfiguration,
  project: ProjectPolicy,
  repository: RepositoryPolicy,
  sessionId: string,
  workspacePath: string,
  branchPrefix: string,
): Promise<SessionWorkspaceRepositoryRecord> {
  const repositoryPath = await verifyRepositoryPolicy(project, repository);
  const releaseLock = await acquireRepositoryLock(configuration, repositoryPath);
  const worktreePath = path.join(workspacePath, repository.relativePath);
  const branchName = validateWorktreeBranchName(branchPrefix);
  let branchCreationAttempted = false;

  try {
    await fsp.mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
    branchCreationAttempted = true;
    await runGitCommand([
      'fetch',
      '--atomic',
      repository.remoteName,
      `+refs/heads/${repository.baseBranch}:refs/remotes/${repository.remoteName}/${repository.baseBranch}`,
    ], repositoryPath);

    const remoteRef = `refs/remotes/${repository.remoteName}/${repository.baseBranch}`;
    const { stdout: baseOutput } = await runGitCommand(
      ['rev-parse', '--verify', `${remoteRef}^{commit}`],
      repositoryPath,
    );
    const baseSha = baseOutput.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) {
      throw new AppError(`Could not resolve the fetched base for "${repository.displayName}".`, {
        code: 'SESSION_WORKSPACE_BASE_INVALID',
        statusCode: 500,
      });
    }

    const { stdout: existingBranchOutput } = await runGitCommand(
      ['branch', '--list', branchName, '--format=%(refname:short)'],
      repositoryPath,
    );
    if (existingBranchOutput.trim()) {
      throw new AppError(`Session branch "${branchName}" already exists.`, {
        code: 'SESSION_WORKSPACE_BRANCH_EXISTS',
        statusCode: 409,
      });
    }

    await runGitCommand([
      'worktree',
      'add',
      '--lock',
      '--reason',
      `cloudcli-session:${sessionId}`,
      '-b',
      branchName,
      worktreePath,
      baseSha,
    ], repositoryPath);

    const [{ stdout: createdHead }, { stdout: createdStatus }] = await Promise.all([
      runGitCommand(['rev-parse', 'HEAD'], worktreePath),
      runGitCommand(['status', '--porcelain'], worktreePath),
    ]);
    if (createdHead.trim() !== baseSha || createdStatus.trim()) {
      throw new AppError(`Worktree verification failed for "${repository.displayName}".`, {
        code: 'SESSION_WORKSPACE_VERIFICATION_FAILED',
        statusCode: 500,
      });
    }

    return {
      repositoryKey: repository.key,
      sourcePath: repositoryPath,
      worktreePath: normalizeProjectPath(worktreePath),
      branchName,
      remoteName: repository.remoteName,
      baseBranch: repository.baseBranch,
      baseSha,
    };
  } catch (error) {
    if (branchCreationAttempted) {
      await runGitCommand(['worktree', 'unlock', worktreePath], repositoryPath).catch(() => undefined);
      await runGitCommand(['worktree', 'remove', '--force', worktreePath], repositoryPath).catch(() => undefined);
      await runGitCommand(['branch', '-D', branchName], repositoryPath).catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

async function removeProvisionedRepository(
  configuration: SessionWorkspaceConfiguration,
  repository: SessionWorkspaceRepositoryRecord,
): Promise<void> {
  const releaseLock = await acquireRepositoryLock(configuration, repository.sourcePath);
  try {
    await runGitCommand(['worktree', 'unlock', repository.worktreePath], repository.sourcePath).catch(() => undefined);
    await runGitCommand(['worktree', 'remove', '--force', repository.worktreePath], repository.sourcePath)
      .catch(() => undefined);
    // Compensation happens before the workspace can be returned to a user, so
    // the freshly-created branch cannot contain user work.
    await runGitCommand(['branch', '-D', repository.branchName], repository.sourcePath)
      .catch(() => undefined);
  } finally {
    await releaseLock();
  }
}

async function writeWorkspaceMetadata(
  project: ProjectPolicy,
  result: ProvisionSessionWorkspaceResult,
): Promise<void> {
  for (const fileName of ['AGENTS.md', 'PROJECT_GUIDE.md']) {
    await fsp.copyFile(
      path.join(project.sourceProjectPath, fileName),
      path.join(result.workspacePath, fileName),
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
  }

  const inventory = {
    schemaVersion: 1,
    workspaceKind: 'cloudcli-session-worktree',
    workspaceRoot: result.workspacePath,
    sourceWorkspaceRoot: result.sourceProjectPath,
    sessionBranchPrefix: result.branchPrefix,
    localRepositories: result.repositories.map((repository) =>
      path.relative(result.workspacePath, repository.worktreePath)),
    containsSecrets: false,
  };
  await fsp.writeFile(
    path.join(result.workspacePath, '.comic-workspace.local.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

/**
 * Session workspace manager consumed by Providers, Worktrees routes, and Git
 * safety guards. Configuration is local-only and disabled when the environment
 * variable is absent, preserving upstream single-user behavior by default.
 */
export const sessionWorkspaceService: SessionWorkspaceService = {
  async plan(sourceProjectPath) {
    const configuration = loadConfiguration();
    if (!configuration) {
      return {
        enabled: false,
        requiresSelection: false,
        defaultRepositoryKeys: [],
        repositories: [],
      };
    }

    const match = findProjectPolicy(configuration, sourceProjectPath);
    if (!match) {
      return {
        enabled: false,
        requiresSelection: false,
        defaultRepositoryKeys: [],
        repositories: [],
      };
    }
    return planFromPolicy(match.project, match.selectedRepositoryKey);
  },

  async provision(input) {
    // Keep this check as the first service-level boundary.  The Providers
    // route normally decides whether to call provision at all, but future
    // routes/jobs may invoke this service directly and must still fail closed
    // before loading policy files, fetching Git refs, or creating directories.
    assertSessionWorkspaceProvisioningAllowed();

    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      throw new AppError('Invalid session id for workspace provisioning.', {
        code: 'SESSION_WORKSPACE_SESSION_ID_INVALID',
        statusCode: 400,
      });
    }

    const configuration = loadConfiguration();
    if (!configuration) {
      throw new AppError('Session workspace isolation is not configured.', {
        code: 'SESSION_WORKSPACE_DISABLED',
        statusCode: 409,
      });
    }
    const match = findProjectPolicy(configuration, input.sourceProjectPath);
    if (!match) {
      throw new AppError('This project is not configured for isolated sessions.', {
        code: 'SESSION_WORKSPACE_PROJECT_UNMANAGED',
        statusCode: 409,
      });
    }

    const availablePlan = planFromPolicy(match.project, match.selectedRepositoryKey);
    const requestedKeys = Array.from(new Set(input.repositoryKeys));
    if (requestedKeys.length === 0 && availablePlan.requiresSelection) {
      throw new AppError('Select at least one repository for this session.', {
        code: 'SESSION_WORKSPACE_SELECTION_REQUIRED',
        statusCode: 409,
        details: availablePlan,
      });
    }
    const effectiveKeys = requestedKeys.length > 0
      ? requestedKeys
      : availablePlan.defaultRepositoryKeys;
    if (effectiveKeys.length === 0) {
      throw new AppError('No writable repository is available for this session.', {
        code: 'SESSION_WORKSPACE_REPOSITORY_REQUIRED',
        statusCode: 409,
      });
    }

    const repositories = effectiveKeys.map((key) => {
      const repository = match.project.repositories.find((candidate) => candidate.key === key);
      if (!repository || (match.selectedRepositoryKey && repository.key !== match.selectedRepositoryKey)) {
        throw new AppError(`Repository selection "${key}" is not allowed for this project.`, {
          code: 'SESSION_WORKSPACE_REPOSITORY_NOT_ALLOWED',
          statusCode: 400,
        });
      }
      if (!repository.writable) {
        throw new AppError(`Repository "${repository.displayName}" is read-only.`, {
          code: 'SESSION_WORKSPACE_REPOSITORY_READ_ONLY',
          statusCode: 409,
        });
      }
      return repository;
    }).sort((left, right) => left.key.localeCompare(right.key));

    const requestedWorkspacePath = normalizeProjectPath(path.join(configuration.workspaceRoot, input.sessionId));
    assertPathInside(configuration.workspaceRoot, requestedWorkspacePath, 'Session workspace path');
    if (fs.existsSync(requestedWorkspacePath)) {
      throw new AppError('The session workspace already exists.', {
        code: 'SESSION_WORKSPACE_ALREADY_EXISTS',
        statusCode: 409,
      });
    }
    await fsp.mkdir(configuration.workspaceRoot, { recursive: true, mode: 0o700 });
    const canonicalWorkspaceRoot = normalizeProjectPath(await fsp.realpath(configuration.workspaceRoot));
    if (canonicalWorkspaceRoot !== configuration.workspaceRoot) {
      throw configurationError('workspaceRoot changed after configuration was loaded.');
    }
    await fsp.mkdir(requestedWorkspacePath, { recursive: false, mode: 0o700 });
    const workspacePath = normalizeProjectPath(await fsp.realpath(requestedWorkspacePath));
    assertPathInside(canonicalWorkspaceRoot, workspacePath, 'Session workspace path');

    const branchPrefix = validateWorktreeBranchName(`cloudcli/session/${input.sessionId}`);
    const createdRepositories: SessionWorkspaceRepositoryRecord[] = [];
    try {
      // Repositories have independent Git common directories and locks, so
      // prepare them concurrently. Wait for every attempt before compensating:
      // Promise.all's early rejection would otherwise let a late worktree
      // finish after the rollback had already scanned the success list.
      const results = await Promise.allSettled(repositories.map((repository) =>
        createRepositoryWorktree(
          configuration,
          match.project,
          repository,
          input.sessionId,
          workspacePath,
          branchPrefix,
        )));
      for (const result of results) {
        if (result.status === 'fulfilled') {
          createdRepositories.push(result.value);
        }
      }
      const failed = results.find((result): result is PromiseRejectedResult =>
        result.status === 'rejected');
      if (failed) {
        throw failed.reason;
      }

      const result: ProvisionSessionWorkspaceResult = {
        // Persist the policy's canonical source rather than a request alias;
        // this keeps later baseline/workspace checks on one stable path key.
        sourceProjectPath: match.project.sourceProjectPath,
        workspacePath,
        branchPrefix,
        repositories: createdRepositories,
      };
      await writeWorkspaceMetadata(match.project, result);
      return result;
    } catch (error) {
      for (const repository of [...createdRepositories].reverse()) {
        await removeProvisionedRepository(configuration, repository);
      }
      await fsp.rm(workspacePath, { recursive: true, force: true });
      throw error;
    }
  },

  async rollback(provisioned) {
    const configuration = loadConfiguration();
    if (!configuration) {
      throw configurationError('Cannot roll back a session workspace while isolation is disabled.');
    }
    const canonicalWorkspaceRoot = canonicalizePolicyPath(configuration.workspaceRoot);
    const canonicalWorkspacePath = await fsp.realpath(provisioned.workspacePath)
      .then((resolved) => normalizeProjectPath(resolved))
      .catch(() => canonicalizePolicyPath(provisioned.workspacePath));
    assertPathInside(canonicalWorkspaceRoot, canonicalWorkspacePath, 'Session workspace path');
    for (const repository of [...provisioned.repositories].reverse()) {
      await removeProvisionedRepository(configuration, repository);
    }
    await fsp.rm(canonicalWorkspacePath, { recursive: true, force: true });
  },

  isProtectedBaselinePath(projectPath) {
    const configuration = loadConfiguration();
    if (!configuration) {
      return false;
    }
    const normalized = canonicalizePolicyPath(projectPath);
    return configuration.projects.some((project) => {
      const baselineRoots = [
        project.sourceProjectPath,
        ...project.repositories.map((repository) =>
          canonicalizePolicyPath(path.join(project.sourceProjectPath, repository.relativePath))),
      ];
      return baselineRoots.some((baselineRoot) =>
        isPathInsideOrEqual(canonicalizePolicyPath(baselineRoot), normalized));
    });
  },

  isManagedWorkspacePath(projectPath) {
    const configuration = loadConfiguration();
    if (!configuration) {
      return false;
    }
    const normalized = canonicalizePolicyPath(projectPath);
    const relative = path.relative(configuration.workspaceRoot, normalized);
    return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  },
};
