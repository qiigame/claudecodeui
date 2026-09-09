// @ts-nocheck -- dynamic provider event payloads are normalized at the injected writer boundary.
import path from 'path';

import express from 'express';

import {
  captureDeploymentPolicy,
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
// Keep the auth declaration separate from the deployment profile.  A writable
// `developer` profile may intentionally run behind DingTalk SSO; in that
// hybrid mode the profile alone must not make this legacy API-key execution
// endpoint trust an arbitrary local account.
import { AUTH_DEPLOYMENT_MODE } from '@/modules/auth/auth-policy.js';
import type { ProviderRunFunction } from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

type AgentRouterDependencies = {
  fileSystem: typeof import('node:fs/promises');
  crypto: typeof import('node:crypto');
  homeDirectory(): string;
  spawnProcess: typeof import('cross-spawn').default;
  /**
   * @deprecated Only retained for standalone callers created before the
   * deployment/auth policy split. Production composition must provide
   * `allowUnauthenticatedPlatform` and a startup deployment policy instead.
   */
  platformMode?: boolean;
  /**
   * Explicit server-owned switch for the legacy managed-platform principal.
   * This is intentionally separate from the broad `VITE_IS_PLATFORM` flag:
   * DingTalk/SSO deployments can keep that presentation flag while still
   * requiring a user credential on this legacy API-key surface.
   */
  allowUnauthenticatedPlatform?: boolean;
  users: { getFirstUser(): unknown };
  apiKeys: { validateApiKey(apiKey: string): unknown };
  githubTokens: { getActiveGithubToken(userId: number): string | null };
  projects: { createProjectPath(projectPath: string, customName: string | null): unknown };
  models: typeof import('../providers/index.js').providerModelsService;
  queryClaude: ProviderRunFunction;
  queryCursor: ProviderRunFunction;
  queryCodex: ProviderRunFunction;
  queryOpenCode: ProviderRunFunction;
  GithubClient: typeof import('@octokit/rest').Octokit;
  /** Optional identity gate for the legacy API-key execution surface. */
  assertActorCanWrite?: (userId: number) => void;
  /**
   * Startup-owned SSO switch. When true, even an explicitly writable
   * `developer` profile must carry a verified DingTalk actor; this covers a
   * developer deployment that intentionally enables DingTalk authentication.
   * An explicit false keeps legacy platform/self-hosted accounts from being
   * incorrectly blocked by a stale identity registry only when the immutable
   * startup auth snapshot itself does not require DingTalk; it cannot weaken
   * an already-managed SSO process.
   */
  requireVerifiedActor?: boolean;
  /** Optional execution attribution used by the production API-key surface. */
  executionAttribution?: {
    beginExecution(input: {
      userId: string | number | null | undefined;
      sessionId: string | null;
      provider: string;
      projectPath: string;
    }): {
      runId: string;
      environment: Record<string, string>;
    };
    completeExecution(runId: string, status: 'succeeded' | 'failed'): void;
  };
  /** Startup-resolved deployment policy; omitted only for legacy/test callers. */
  deploymentPolicy?: DeploymentPolicy | (() => DeploymentPolicy);
};

const MANAGED_AGENT_PROFILES = new Set<DeploymentPolicy['profile']>([
  'platform',
  'production',
  'product-qa-readonly',
]);

/**
 * Creates Agent routes around explicit authentication, repository, provider,
 * filesystem, subprocess, runtime, and GitHub dependencies.
 */
export function createAgentRouter(dependencies: AgentRouterDependencies): express.Router {
  const fs = dependencies.fileSystem;
  const crypto = dependencies.crypto;
  const os = { homedir: dependencies.homeDirectory };
  const spawn = dependencies.spawnProcess;
  const legacyPlatformMode = dependencies.platformMode === true;
  const userDb = dependencies.users;
  const apiKeysDb = dependencies.apiKeys;
  const githubTokensDb = dependencies.githubTokens;
  const projectsDb = dependencies.projects;
  const providerModelsService = dependencies.models;
  const queryClaudeSDK = dependencies.queryClaude;
  const spawnCursor = dependencies.queryCursor;
  const queryCodex = dependencies.queryCodex;
  const spawnOpenCode = dependencies.queryOpenCode;
  const Octokit = dependencies.GithubClient;
  const router = express.Router();
  // A policy source is a startup hook, not a per-request resolver. Capture it
  // once so an alternate Agent mount cannot drift after process startup.
  const startupDeploymentPolicy = captureDeploymentPolicy(dependencies.deploymentPolicy);

  /**
   * Identity enrollment is a managed-SSO boundary, not a blanket requirement
   * for every local installation that happens to have a registry file. Keep
   * the legacy API-key Agent usable on explicit developer/self-hosted profiles;
   * managed profiles still require the verified actor before any clone or
  * provider process is started.
  */
  const assertAuthenticatedActorCanWrite = (user: unknown, req): void => {
    const hasExplicitPolicy = dependencies.deploymentPolicy !== undefined
      || req?.deploymentPolicy !== undefined;
    const profileRequiresActor = hasExplicitPolicy
      && MANAGED_AGENT_PROFILES.has(resolveDeploymentPolicy(req).profile);
    // `requireVerifiedActor` is the composition-root override.  When an
    // embedder omits it, retain the legacy profile behavior but also honor the
    // immutable auth startup snapshot: explicit `developer` + DingTalk SSO is
    // still a managed identity boundary, even though its capability profile
    // remains writable.  This prevents an API-key caller from bypassing SSO in
    // a standalone composition while leaving ordinary local developer mode
    // untouched.
    // The composition root owns the SSO decision.  An older embedder may
    // explicitly pass `false`, but that value cannot weaken a startup
    // DingTalk requirement; otherwise this legacy API-key endpoint would be a
    // straightforward SSO bypass.  When the startup snapshot is ordinary
    // local mode, retain the explicit/legacy behavior for compatibility.
    const requiresVerifiedActor = AUTH_DEPLOYMENT_MODE.requiresDingTalk
      || dependencies.requireVerifiedActor === true
      || (dependencies.requireVerifiedActor === undefined
        ? (hasExplicitPolicy
          ? profileRequiresActor
          : true)
        : false);
    if (!requiresVerifiedActor) {
      return;
    }
    if (!dependencies.assertActorCanWrite) {
      // A managed/explicit SSO composition must not silently become an
      // unauthenticated Agent execution surface merely because an embedder
      // forgot to inject the collaboration adapter. Keep the historical
      // legacy standalone behavior only when no deployment policy or explicit
      // actor requirement was supplied at all.
      if (hasExplicitPolicy
        || dependencies.requireVerifiedActor === true
        || AUTH_DEPLOYMENT_MODE.requiresDingTalk) {
        throw new AppError('A registered project identity is required for Agent execution.', {
          code: 'IDENTITY_ENROLLMENT_REQUIRED',
          statusCode: 403,
        });
      }
      return;
    }
    const candidate = user && typeof user === 'object'
      ? (user as Record<string, unknown>).id ?? (user as Record<string, unknown>).userId
      : undefined;
    const userId = typeof candidate === 'number' ? candidate : Number(candidate);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new AppError('A registered project identity is required for Agent execution.', {
        code: 'IDENTITY_ENROLLMENT_REQUIRED',
        statusCode: 403,
      });
    }
    dependencies.assertActorCanWrite(userId);
  };

  const resolveDeploymentPolicy = (req) => {
    return req.deploymentPolicy ?? startupDeploymentPolicy;
  };

  /**
   * Resolves the only condition under which the legacy Agent endpoint may use
   * the first local user instead of a request credential. Once a deployment
   * policy is supplied, a missing explicit switch fails closed; the old
   * `platformMode` fallback is kept solely for isolated callers/tests that do
   * not participate in the server composition root.
   */
  const allowUnauthenticatedPlatform = (req): boolean => {
    if (dependencies.allowUnauthenticatedPlatform !== undefined) {
      return dependencies.allowUnauthenticatedPlatform === true;
    }
    // A request-scoped policy is the production composition root's signal
    // even when this router was constructed without an injected policy (for
    // example, a mounted test adapter). Never let the legacy boolean win over
    // that server-owned context.
    if (dependencies.deploymentPolicy || req?.deploymentPolicy) {
      return false;
    }
    return legacyPlatformMode;
  };

  /**
   * The legacy Agent endpoint can clone repositories, run a provider with
   * permissions bypassed, create branches, push, and open pull requests. It
   * therefore has its own capability boundary in addition to API-key auth.
   * Keep this middleware before API-key validation and all route handlers so a
   * product/QA deployment cannot even probe or clone through this endpoint.
   */
  const requireAgentCapability = (req, res, next) => {
    const policy = resolveDeploymentPolicy(req);
    if (!hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.AGENT_USE)) {
      return next(new AppError('Agent execution is disabled for this deployment.', {
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        statusCode: 403,
        details: {
          profile: policy.profile,
          capability: DEPLOYMENT_CAPABILITIES.AGENT_USE,
        },
      }));
    }
    req.deploymentPolicy = policy;
    return next();
  };

  /**
   * Middleware to authenticate agent API requests.
   *
   * Supports two authentication modes:
   * 1. Platform mode (IS_PLATFORM=true): For managed/hosted deployments where
   *    authentication is handled by an external proxy. Requests are trusted and
   *    the default user context is used.
   *
   * 2. API key mode (default): For self-hosted deployments where users authenticate
   *    via API keys created in the UI. Keys are validated against the local database.
   */
  const validateExternalApiKey = (req, res, next) => {
    // Platform mode: Authentication is handled externally (e.g., by a proxy layer).
    // Trust the request and use the default user context.
    if (allowUnauthenticatedPlatform(req)) {
      let user;
      try {
        user = userDb.getFirstUser();
        if (!user) {
          return res.status(500).json({ error: 'Platform mode: No user found in database' });
        }
      } catch (error) {
        console.error(
          'Platform mode error:',
          sanitizeAgentDiagnostic(error?.message ?? error),
        );
        return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
      }
      req.user = user;
      try {
        assertAuthenticatedActorCanWrite(user, req);
      } catch (error) {
        return next(error);
      }
      return next();
    }

    // Self-hosted mode: Validate API key from header or query parameter
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    const user = apiKeysDb.validateApiKey(apiKey);

    if (!user) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    req.user = user;
    try {
      assertAuthenticatedActorCanWrite(user, req);
    } catch (error) {
      return next(error);
    }
    next();
  };

  /**
   * Get the remote URL of a git repository
   * @param {string} repoPath - Path to the git repository
   * @returns {Promise<string>} - Remote URL of the repository
   */
  async function getGitRemoteUrl(repoPath) {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(
            `Failed to get git remote: ${sanitizeAgentDiagnostic(stderr)}`,
          ));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(
          `Failed to execute git: ${sanitizeAgentDiagnostic(error.message)}`,
        ));
      });
    });
  }

  /**
   * Normalize GitHub URLs for comparison
   * @param {string} url - GitHub URL
  * @returns {string} - Normalized URL
  */
  function normalizeGitHubUrl(url) {
    // Normalize separators before removing `.git`, so a harmless trailing
    // slash on an existing remote does not turn a matching checkout into a
    // false conflict.
    let normalized = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
    // Convert SSH to HTTPS format for comparison
    normalized = normalized.replace(/^git@github\.com:/i, 'https://github.com/');
    return normalized.toLowerCase();
  }

  /**
   * Parse a canonical GitHub URL to extract owner and repo. This legacy
   * endpoint subsequently calls the GitHub API, so substring matching is not
   * sufficient: `github.com.evil.example` and credential/query-bearing URLs
   * must never be accepted as a GitHub remote.
   * @param {string} url - GitHub URL (HTTPS or SSH)
   * @returns {{owner: string, repo: string}} - Parsed owner and repo
   */
  function parseGitHubUrl(url) {
    const value = typeof url === 'string' ? url.trim() : '';
    let repositoryPath = '';

    // The documented SCP-style SSH form is deliberately handled separately;
    // accepting arbitrary URL schemes here would broaden the old API's remote
    // trust boundary.
    if (value.startsWith('git@github.com:')) {
      repositoryPath = value.slice('git@github.com:'.length);
    } else {
      let parsedUrl;
      try {
        parsedUrl = new URL(value);
      } catch {
        throw new Error('Invalid GitHub URL format');
      }
      if (
          parsedUrl.protocol !== 'https:'
          || parsedUrl.hostname.toLowerCase() !== 'github.com'
          || parsedUrl.port
          || parsedUrl.username
        || parsedUrl.password
        || parsedUrl.search
        || parsedUrl.hash
      ) {
        throw new Error('Invalid GitHub URL format');
      }
      repositoryPath = parsedUrl.pathname;
    }

    const segments = repositoryPath.replace(/\/+$/, '').split('/');
    if (
      segments.length !== 2
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[0])
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\.git)?$/i.test(segments[1])
    ) {
      throw new Error('Invalid GitHub URL format');
    }

    return {
      owner: segments[0],
      repo: segments[1].replace(/\.git$/i, ''),
    };
  }

  /**
   * Redacts credentials from diagnostics before they reach logs or transports.
   * Clone credentials are intentionally supplied through the child environment,
   * but Git can still echo a URL or an Authorization value on failure.
   */
  const sanitizeAgentDiagnostic = (value, secret = null) => {
    let sanitized = typeof value === 'string' ? value : String(value ?? '');
    const secretCandidates = new Set<string>();

    if (typeof secret === 'string' && secret.length > 0) {
      secretCandidates.add(secret);
      for (const encoder of [encodeURIComponent, encodeURI]) {
        try {
          secretCandidates.add(encoder(secret));
        } catch {
          // Ignore malformed input; the literal value is still redacted.
        }
      }
      try {
        secretCandidates.add(decodeURIComponent(secret));
      } catch {
        // A token may not be URI encoded; there is no decoded variant then.
      }

      // Git may print HTTP Basic credentials as base64 instead of the token.
      for (const username of ['', 'x-access-token']) {
        try {
          secretCandidates.add(Buffer.from(`${username}:${secret}`).toString('base64'));
        } catch {
          // Ignore an unavailable encoder and continue with literal redaction.
        }
      }
    }

    for (const candidate of [...secretCandidates]
      .filter((candidate) => candidate.length > 0)
      .sort((left, right) => right.length - left.length)) {
      sanitized = sanitized.split(candidate).join('[REDACTED]');
    }

    // Defense in depth for credentials supplied in a diagnostic URL even when
    // the caller's token is unavailable to this request.
    return sanitized
      .replace(/([a-z][a-z\d+.-]*:\/\/)(?:[^/\s@]*@)/gi, '$1[REDACTED]@')
      .replace(/([?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|key|password|passwd|secret|signature|sig|token)=)[^&#\s]*/gi, '$1[REDACTED]')
      .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/gi, '$1[REDACTED]');
  };

  /**
   * Auto-generate a branch name from a message
   * @param {string} message - The agent message
   * @returns {string} - Generated branch name
   */
  function autogenerateBranchName(message) {
    // Convert to lowercase, replace spaces/special chars with hyphens
    let branchName = message
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

    // Ensure non-empty fallback
    if (!branchName) {
      branchName = 'task';
    }

    // Generate timestamp suffix (last 6 chars of base36 timestamp)
    const timestamp = Date.now().toString(36).slice(-6);
    const suffix = `-${timestamp}`;

    // Limit length to ensure total length including suffix fits within 50 characters
    const maxBaseLength = 50 - suffix.length;
    if (branchName.length > maxBaseLength) {
      branchName = branchName.substring(0, maxBaseLength);
    }

    // Remove any trailing hyphen after truncation and ensure no leading hyphen
    branchName = branchName.replace(/-$/, '').replace(/^-+/, '');

    // If still empty or starts with hyphen after cleanup, use fallback
    if (!branchName || branchName.startsWith('-')) {
      branchName = 'task';
    }

    // Combine base name with timestamp suffix
    branchName = `${branchName}${suffix}`;

    // Final validation: ensure it matches safe pattern
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)) {
      // Fallback to deterministic safe name
      return `branch-${timestamp}`;
    }

    return branchName;
  }

  /**
   * Validate a Git branch name
   * @param {string} branchName - Branch name to validate
   * @returns {{valid: boolean, error?: string}} - Validation result
   */
  function validateBranchName(branchName) {
    if (!branchName || branchName.trim() === '') {
      return { valid: false, error: 'Branch name cannot be empty' };
    }

    // Git branch name rules
    const invalidPatterns = [
      { pattern: /^\./, message: 'Branch name cannot start with a dot' },
      { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
      { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
      { pattern: /\s/, message: 'Branch name cannot contain spaces' },
      { pattern: /[~^:?*\[\\]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
      { pattern: /@{/, message: 'Branch name cannot contain @{' },
      { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
      { pattern: /^\//, message: 'Branch name cannot start with a slash' },
      { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
      { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' }
    ];

    for (const { pattern, message } of invalidPatterns) {
      if (pattern.test(branchName)) {
        return { valid: false, error: message };
      }
    }

    // Check for ASCII control characters
    if (/[\x00-\x1F\x7F]/.test(branchName)) {
      return { valid: false, error: 'Branch name cannot contain control characters' };
    }

    return { valid: true };
  }

  /**
   * Get recent commit messages from a repository
   * @param {string} projectPath - Path to the git repository
   * @param {number} limit - Number of commits to retrieve (default: 5)
   * @returns {Promise<string[]>} - Array of commit messages
   */
  async function getCommitMessages(projectPath, limit = 5) {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          const messages = stdout.trim().split('\n').filter(msg => msg.length > 0);
          resolve(messages);
        } else {
          reject(new Error(
            `Failed to get commit messages: ${sanitizeAgentDiagnostic(stderr)}`,
          ));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(
          `Failed to execute git: ${sanitizeAgentDiagnostic(error.message)}`,
        ));
      });
    });
  }

  /**
   * Create a new branch on GitHub using the API
   * @param {Octokit} octokit - Octokit instance
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branchName - Name of the new branch
   * @param {string} baseBranch - Base branch to branch from (default: 'main')
   * @returns {Promise<void>}
   */

  /**
   * Create a pull request on GitHub
   * @param {Octokit} octokit - Octokit instance
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branchName - Head branch name
   * @param {string} title - PR title
   * @param {string} body - PR body/description
   * @param {string} baseBranch - Base branch (default: 'main')
   * @returns {Promise<{number: number, url: string}>} - PR number and URL
   */
  async function createGitHubPR(octokit, owner, repo, branchName, title, body, baseBranch = 'main') {
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title,
      head: branchName,
      base: baseBranch,
      body
    });

    console.log(`✅ Created pull request #${pr.number}: ${pr.html_url}`);

    return {
      number: pr.number,
      url: pr.html_url
    };
  }

  /**
   * Clone a GitHub repository to a directory
   * @param {string} githubUrl - GitHub repository URL
   * @param {string} githubToken - Optional GitHub token for private repos
   * @param {string} projectPath - Path for cloning the repository
   * @returns {Promise<{path: string, created: boolean}>} - Checkout path and ownership flag
   */
  async function cloneGitHubRepo(githubUrl, githubToken = null, projectPath) {
    return new Promise(async (resolve, reject) => {
      try {
        // Validate the host before using credentials or invoking Git.
        let parsedGithubUrl;
        try {
          parsedGithubUrl = new URL(String(githubUrl).trim());
        } catch {
          throw new Error('Invalid GitHub URL');
        }
        if (
          parsedGithubUrl.protocol !== 'https:'
          || parsedGithubUrl.hostname !== 'github.com'
          || parsedGithubUrl.port
          || parsedGithubUrl.username
          || parsedGithubUrl.password
          // Query strings/fragments are not part of a repository clone URL.
          // Reject them instead of allowing a caller to smuggle a token into
          // git's argv, logs, or a downstream error message.
          || parsedGithubUrl.search
          || parsedGithubUrl.hash
        ) {
          throw new Error('Invalid GitHub URL');
        }

        // Keep the argv URL canonical and limited to a GitHub repository path.
        // This also prevents encoded query/credential material from surviving
        // URL parsing as part of the path.
        const repositoryPath = parsedGithubUrl.pathname.replace(/\/+$/, '');
        const pathSegments = repositoryPath.split('/');
        if (
          pathSegments.length !== 3
          || pathSegments[0] !== ''
          || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathSegments[1])
          || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\.git)?$/.test(pathSegments[2])
        ) {
          throw new Error('Invalid GitHub URL');
        }
        const cloneUrl = `https://github.com/${pathSegments[1]}/${pathSegments[2]}`;

        const cloneDir = path.resolve(projectPath);

        // Check if the destination already exists. Keep this existence probe
        // separate from the repository validation below: an outer catch around
        // both operations would swallow a URL mismatch/non-git error and then
        // continue into `git clone`, potentially writing into another user's
        // checkout or masking the real conflict.
        let cloneDirectoryExists = true;
        try {
          await fs.access(cloneDir);
        } catch (accessError) {
          // Node's fs errors carry ENOENT for a missing path. Any other
          // explicitly coded failure (for example EACCES) must not be treated
          // as absence, otherwise a clone could be attempted through a path we
          // were not allowed to inspect.
          const accessCode = accessError && typeof accessError === 'object'
            ? (accessError as { code?: string }).code
            : undefined;
          if (accessCode && accessCode !== 'ENOENT') {
            const safeAccessError = sanitizeAgentDiagnostic(
              accessError?.message ?? accessError,
              githubToken,
            );
            throw new Error(`Unable to inspect clone destination: ${safeAccessError}`);
          }
          cloneDirectoryExists = false;
        }

        if (cloneDirectoryExists) {
          // Directory exists - check if it is a git repo with the same URL.
          let existingUrl;
          try {
            existingUrl = await getGitRemoteUrl(cloneDir);
          } catch (gitError) {
            const safeGitError = sanitizeAgentDiagnostic(
              gitError?.message ?? gitError,
              githubToken,
            );
            throw new Error(
              `Directory ${cloneDir} already exists but is not a valid git repository or git command failed${safeGitError ? `: ${safeGitError}` : ''}`,
            );
          }

          const normalizedExisting = normalizeGitHubUrl(existingUrl);
          const normalizedRequested = normalizeGitHubUrl(cloneUrl);

          if (normalizedExisting === normalizedRequested) {
            console.log('✅ Repository already exists at path with correct URL');
            return resolve({ path: cloneDir, created: false });
          }

          // Do not fall through to clone: the destination belongs to a
          // different repository and must be left untouched.
          throw new Error(`Directory ${cloneDir} already exists with a different repository. Expected: ${cloneUrl}`);
        }

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(cloneDir), { recursive: true });

        console.log('🔄 Cloning repository:', cloneUrl);
        console.log('📁 Destination:', cloneDir);

        // Execute git clone
        const gitEnvironment = githubToken ? {
          ...process.env,
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: 'credential.helper',
          GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$CLOUDCLI_GITHUB_TOKEN"; }; f',
          CLOUDCLI_GITHUB_TOKEN: githubToken,
          GIT_TERMINAL_PROMPT: '0'
        } : process.env;
        const gitProcess = spawn('git', ['clone', '--depth', '1', '--', cloneUrl, cloneDir], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: gitEnvironment
        });

        let stdout = '';
        let stderr = '';

        gitProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        gitProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        gitProcess.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Repository cloned successfully');
            resolve({ path: cloneDir, created: true });
          } else {
            const safeStderr = sanitizeAgentDiagnostic(stderr, githubToken);
            console.error('❌ Git clone failed:', safeStderr);
            reject(new Error(`Git clone failed: ${safeStderr}`));
          }
        });

        gitProcess.on('error', (error) => {
          const safeMessage = sanitizeAgentDiagnostic(error.message, githubToken);
          reject(new Error(`Failed to execute git: ${safeMessage}`));
        });
      } catch (error) {
        const safeMessage = sanitizeAgentDiagnostic(error?.message ?? error, githubToken);
        reject(new Error(safeMessage));
      }
    });
  }

  /**
   * Clean up a temporary project directory and its Claude session
   * @param {string} projectPath - Path to the project directory
   * @param {string} sessionId - Session ID to clean up
   */
  async function cleanupProject(projectPath, sessionId = null) {
    try {
      const externalProjectsRoot = await fs.realpath(
        path.join(os.homedir(), '.claude', 'external-projects')
      );
      const canonicalProjectPath = await fs.realpath(projectPath);
      const relativeProjectPath = path.relative(externalProjectsRoot, canonicalProjectPath);
      const isContained = relativeProjectPath !== ''
        && relativeProjectPath !== '..'
        && !relativeProjectPath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativeProjectPath);

      if (!isContained) {
        console.warn('⚠️ Refusing to clean up non-external project:', projectPath);
        return;
      }

      console.log('🧹 Cleaning up project:', projectPath);
      await fs.rm(canonicalProjectPath, { recursive: true, force: true });
      console.log('✅ Project cleaned up');

      // Also clean up the Claude session directory if sessionId provided
      if (sessionId) {
        try {
          const sessionPath = path.join(os.homedir(), '.claude', 'sessions', sessionId);
          console.log('🧹 Cleaning up session directory:', sessionPath);
          await fs.rm(sessionPath, { recursive: true, force: true });
          console.log('✅ Session directory cleaned up');
        } catch (error) {
          console.error(
            '⚠️ Failed to clean up session directory:',
            sanitizeAgentDiagnostic(error?.message ?? error),
          );
        }
      }
    } catch (error) {
      console.error(
        '❌ Failed to clean up project:',
        sanitizeAgentDiagnostic(error?.message ?? error),
      );
    }
  }

  /**
   * SSE Stream Writer - Adapts SDK/CLI output to Server-Sent Events
   */
  class SSEStreamWriter {
    constructor(res, userId = null) {
      this.res = res;
      this.sessionId = null;
      this.userId = userId;
      this.isSSEStreamWriter = true;  // Marker for transport detection
    }

    send(data) {
      if (this.res.writableEnded) {
        return;
      }

      // Format as SSE - providers send raw objects, we stringify
      this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    end() {
      if (!this.res.writableEnded) {
        this.res.write('data: {"type":"done"}\n\n');
        this.res.end();
      }
    }

    setSessionId(sessionId) {
      this.sessionId = sessionId;
      this.send({ type: 'session-id', sessionId });
    }

    getSessionId() {
      return this.sessionId;
    }
  }

  /**
   * Non-streaming response collector
   */
  class ResponseCollector {
    constructor(userId = null) {
      this.messages = [];
      this.sessionId = null;
      this.userId = userId;
    }

    send(data) {
      // Store ALL messages for now - we'll filter when returning
      this.messages.push(data);

      // Extract sessionId if present
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.sessionId) {
            this.sessionId = parsed.sessionId;
          }
        } catch (e) {
          // Not JSON, ignore
        }
      } else if (data && data.sessionId) {
        this.sessionId = data.sessionId;
      }
    }

    end() {
      // Do nothing - we'll collect all messages
    }

    setSessionId(sessionId) {
      this.sessionId = sessionId;
    }

    getSessionId() {
      return this.sessionId;
    }

    getMessages() {
      return this.messages;
    }

    /**
     * Get filtered assistant messages only
     */
    getAssistantMessages() {
      const assistantMessages = [];

      for (const msg of this.messages) {
        // Skip initial status message
        if (msg && msg.type === 'status') {
          continue;
        }

        // Handle JSON strings
        if (typeof msg === 'string') {
          try {
            const parsed = JSON.parse(msg);
            // Only include claude-response messages with assistant type
            if (parsed.type === 'claude-response' && parsed.data && parsed.data.type === 'assistant') {
              assistantMessages.push(parsed.data);
            }
          } catch (e) {
            // Not JSON, skip
          }
        }
      }

      return assistantMessages;
    }

    /**
     * Calculate total tokens from all messages
     */
    getTotalTokens() {
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;

      for (const msg of this.messages) {
        let data = msg;

        // Parse if string
        if (typeof msg === 'string') {
          try {
            data = JSON.parse(msg);
          } catch (e) {
            continue;
          }
        }

        // Extract usage from claude-response messages
        if (data && data.type === 'claude-response' && data.data) {
          const msgData = data.data;
          if (msgData.message && msgData.message.usage) {
            const usage = msgData.message.usage;
            totalInput += usage.input_tokens || 0;
            totalOutput += usage.output_tokens || 0;
            totalCacheRead += usage.cache_read_input_tokens || 0;
            totalCacheCreation += usage.cache_creation_input_tokens || 0;
          }
        }
      }

      const inputTokens = totalInput + totalCacheRead + totalCacheCreation;

      return {
        inputTokens,
        outputTokens: totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheCreationTokens: totalCacheCreation,
        totalTokens: inputTokens + totalOutput
      };
    }
  }

  // ===============================
  // External API Endpoint
  // ===============================

  /**
   * POST /api/agent
   *
   * Trigger an AI agent to work on a project.
   * Supports automatic GitHub branch and pull request creation after successful completion.
   *
   * ================================================================================================
   * REQUEST BODY PARAMETERS
   * ================================================================================================
   *
   * @param {string} githubUrl - (Conditionally Required) GitHub repository URL to clone.
   *                             Supported formats:
   *                             - HTTPS: https://github.com/owner/repo
   *                             - HTTPS with .git: https://github.com/owner/repo.git
   *                             - SSH: git@github.com:owner/repo
   *                             - SSH with .git: git@github.com:owner/repo.git
   *
   * @param {string} projectPath - (Conditionally Required) Path to existing project OR destination for cloning.
   *                               Behavior depends on usage:
   *                               - If used alone: Must point to existing project directory
   *                               - If used with githubUrl: Target location for cloning
   *                               - If omitted with githubUrl: Auto-generates temporary path in ~/.claude/external-projects/
   *
   * @param {string} message - (Required) Task description for the AI agent. Used as:
   *                          - Instructions for the agent
   *                          - Source for auto-generated branch names (if createBranch=true and no branchName)
   *                          - Fallback for PR title if no commits are made
   *
   * @param {string} provider - (Optional) AI provider to use. Options: 'claude' | 'cursor' | 'codex' | 'opencode'
   *                           Default: 'claude'
   *
   * @param {boolean} stream - (Optional) Enable Server-Sent Events (SSE) streaming for real-time updates.
   *                          Default: true
   *                          - true: Returns text/event-stream with incremental updates
   *                          - false: Returns complete JSON response after completion
   *
   * @param {string} model - (Optional) Model identifier for providers.
   *
   *                        Claude models: 'default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]', 'fable'
   *                        Cursor models: 'gpt-5' (default), 'gpt-5.2', 'gpt-5.2-high', 'sonnet-4.5', 'opus-4.5',
   *                                       'composer-1', 'auto', 'gpt-5.1', 'gpt-5.1-high',
   *                                       'gpt-5.1-codex', 'gpt-5.1-codex-high', 'gpt-5.1-codex-max',
   *                                       'gpt-5.1-codex-max-high', 'opus-4.1', 'grok', and thinking variants
   *                        Codex models: 'gpt-5.4' (default), 'gpt-5.5', 'gpt-5.4-mini'
   *
   * @param {string} effort - (Optional) Reasoning effort for providers/models that support it.
   *                          Claude supports: 'low', 'medium', 'high', 'xhigh', 'max' depending on model.
   *                          Codex supports: 'low', 'medium', 'high', 'xhigh'.
   *                          'default' or omission lets the provider decide.
   *
   * @param {boolean} cleanup - (Optional) Auto-cleanup project directory after completion.
   *                           Default: true
   *                           Behavior:
   *                           - Only applies when cloning via githubUrl (not for existing projectPath)
   *                           - Deletes cloned repository after 5 seconds
   *                           - Also deletes associated Claude session directory
   *                           - Remote branch and PR remain on GitHub if created
   *
   * @param {string} githubToken - (Optional) GitHub Personal Access Token for authentication.
   *                              Overrides stored token from user settings.
   *                              Required for:
   *                              - Private repositories
   *                              - Branch/PR creation features
   *                              Token must have 'repo' scope for full functionality.
   *
   * @param {string} branchName - (Optional) Custom name for the Git branch.
   *                             If provided, createBranch is automatically set to true.
   *                             Validation rules (errors returned if violated):
   *                             - Cannot be empty or whitespace only
   *                             - Cannot start or end with dot (.)
   *                             - Cannot contain consecutive dots (..)
   *                             - Cannot contain spaces
   *                             - Cannot contain special characters: ~ ^ : ? * [ \
   *                             - Cannot contain @{
   *                             - Cannot start or end with forward slash (/)
   *                             - Cannot contain consecutive slashes (//)
   *                             - Cannot end with .lock
   *                             - Cannot contain ASCII control characters
   *                             Examples: 'feature/user-auth', 'bugfix/login-error', 'refactor/db-optimization'
   *
   * @param {boolean} createBranch - (Optional) Create a new Git branch after successful agent completion.
   *                                Default: false (or true if branchName is provided)
   *                                Behavior:
   *                                - Creates branch locally and pushes to remote
   *                                - If branch exists locally: Checks out existing branch (no error)
   *                                - If branch exists on remote: Uses existing branch (no error)
   *                                - Branch name: Custom (if branchName provided) or auto-generated from message
   *                                - Requires either githubUrl OR projectPath with GitHub remote
   *
   * @param {boolean} createPR - (Optional) Create a GitHub Pull Request after successful completion.
   *                            Default: false
   *                            Behavior:
   *                            - PR title: First commit message (or fallback to message parameter)
   *                            - PR description: Auto-generated from all commit messages
   *                            - Base branch: Always 'main' (currently hardcoded)
   *                            - If PR already exists: GitHub returns error with details
   *                            - Requires either githubUrl OR projectPath with GitHub remote
   *
   * ================================================================================================
   * PATH HANDLING BEHAVIOR
   * ================================================================================================
   *
   * Scenario 1: Only githubUrl provided
   *   Input:  { githubUrl: "https://github.com/owner/repo" }
   *   Action: Clones to auto-generated temporary path: ~/.claude/external-projects/<hash>/
   *   Cleanup: Yes (if cleanup=true)
   *
   * Scenario 2: Only projectPath provided
   *   Input:  { projectPath: "/home/user/my-project" }
   *   Action: Uses existing project at specified path
   *   Validation: Path must exist and be accessible
   *   Cleanup: No (never cleanup existing projects)
   *
   * Scenario 3: Both githubUrl and projectPath provided
   *   Input:  { githubUrl: "https://github.com/owner/repo", projectPath: "/custom/path" }
   *   Action: Clones githubUrl to projectPath location
   *   Validation:
   *     - If projectPath exists with git repo:
   *       - Compares remote URL with githubUrl
   *       - If URLs match: Reuses existing repo
   *       - If URLs differ: Returns error
   *   Cleanup: Yes (if cleanup=true)
   *
   * ================================================================================================
   * GITHUB BRANCH/PR CREATION REQUIREMENTS
   * ================================================================================================
   *
   * For createBranch or createPR to work, one of the following must be true:
   *
   * Option A: githubUrl provided
   *   - Repository URL directly specified
   *   - Works with both cloning and existing paths
   *
   * Option B: projectPath with GitHub remote
   *   - Project must be a Git repository
   *   - Must have 'origin' remote configured
   *   - Remote URL must point to github.com
   *   - System auto-detects GitHub URL via: git remote get-url origin
   *
   * Additional Requirements:
   *   - Valid GitHub token (from settings or githubToken parameter)
   *   - Token must have 'repo' scope for private repos
   *   - Project must have commits (for PR creation)
   *
   * ================================================================================================
   * VALIDATION & ERROR HANDLING
   * ================================================================================================
   *
   * Input Validations (400 Bad Request):
   *   - Either githubUrl OR projectPath must be provided (not neither)
   *   - message must be non-empty string
   *   - provider must be 'claude', 'cursor', 'codex', or 'opencode'
   *   - createBranch/createPR requires githubUrl OR projectPath (not neither)
   *   - branchName must pass Git naming rules (if provided)
   *
   * Runtime Validations (500 Internal Server Error or specific error in response):
   *   - projectPath must exist (if used alone)
   *   - GitHub URL format must be valid
   *   - Git remote URL must include github.com (for projectPath + branch/PR)
   *   - GitHub token must be available (for private repos and branch/PR)
   *   - Directory conflicts handled (existing path with different repo)
   *
   * Branch Name Validation Errors (returned in response, not HTTP error):
   *   Invalid names return: { branch: { error: "Invalid branch name: <reason>" } }
   *   Examples:
   *   - "my branch" → "Branch name cannot contain spaces"
   *   - ".feature" → "Branch name cannot start with a dot"
   *   - "feature.lock" → "Branch name cannot end with .lock"
   *
   * ================================================================================================
   * RESPONSE FORMATS
   * ================================================================================================
   *
   * Streaming Response (stream=true):
   *   Content-Type: text/event-stream
   *   Events:
   *     - { type: "status", message: "...", projectPath: "..." }
   *     - { type: "claude-response", data: {...} }
   *     - { type: "github-branch", branch: { name: "...", url: "..." } }
   *     - { type: "github-pr", pullRequest: { number: 42, url: "..." } }
   *     - { type: "github-error", error: "..." }
   *     - { type: "done" }
   *
   * Non-Streaming Response (stream=false):
   *   Content-Type: application/json
   *   {
   *     success: true,
   *     sessionId: "session-123",
   *     messages: [...],        // Assistant messages only (filtered)
   *     tokens: {
   *       inputTokens: 150,
   *       outputTokens: 50,
   *       cacheReadTokens: 0,
   *       cacheCreationTokens: 0,
   *       totalTokens: 200
   *     },
   *     projectPath: "/path/to/project",
   *     branch: {               // Only if createBranch=true
   *       name: "feature/xyz",
   *       url: "https://github.com/owner/repo/tree/feature/xyz"
   *     } | { error: "..." },
   *     pullRequest: {          // Only if createPR=true
   *       number: 42,
   *       url: "https://github.com/owner/repo/pull/42"
   *     } | { error: "..." }
   *   }
   *
   * Error Response:
   *   HTTP Status: 400, 401, 500
   *   Content-Type: application/json
   *   { success: false, error: "Error description" }
   *
   * ================================================================================================
   * EXAMPLES
   * ================================================================================================
   *
   * Example 1: Clone and process with auto-cleanup
   *   POST /api/agent
   *   { "githubUrl": "https://github.com/user/repo", "message": "Fix bug" }
   *
   * Example 2: Use existing project with custom branch and PR
   *   POST /api/agent
   *   {
   *     "projectPath": "/home/user/project",
   *     "message": "Add feature",
   *     "branchName": "feature/new-feature",
   *     "createPR": true
   *   }
   *
   * Example 3: Clone to specific path with auto-generated branch
   *   POST /api/agent
   *   {
   *     "githubUrl": "https://github.com/user/repo",
   *     "projectPath": "/tmp/work",
   *     "message": "Refactor code",
   *     "createBranch": true,
   *     "cleanup": false
   *   }
   */
  router.post('/', requireAgentCapability, validateExternalApiKey, async (req, res) => {
    const { githubUrl, projectPath, message, provider = 'claude', model, githubToken, branchName, sessionId } = req.body;
    const effort = typeof req.body.effort === 'string' && req.body.effort.trim()
      ? req.body.effort.trim()
      : undefined;

    // Parse stream and cleanup as booleans (handle string "true"/"false" from curl)
    const stream = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
    const cleanup = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');

    // If branchName is provided, automatically enable createBranch
    const createBranch = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
    const createPR = req.body.createPR === true || req.body.createPR === 'true';

    // Validate inputs
    if (!githubUrl && !projectPath) {
      return res.status(400).json({ error: 'Either githubUrl or projectPath is required' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    if (!['claude', 'cursor', 'codex', 'opencode'].includes(provider)) {
      return res.status(400).json({ error: 'provider must be "claude", "cursor", "codex", or "opencode"' });
    }

    // Validate GitHub branch/PR creation requirements
    // Allow branch/PR creation with projectPath as long as it has a GitHub remote
    if ((createBranch || createPR) && !githubUrl && !projectPath) {
      return res.status(400).json({ error: 'createBranch and createPR require either githubUrl or projectPath with a GitHub remote' });
    }

    let finalProjectPath = null;
    let clonedProjectCreated = false;
    let writer = null;
    let execution = null;
    // Keep the active credential available only for diagnostic redaction. It
    // is never interpolated into a URL, subprocess argument, or response.
    let githubTokenForDiagnostics = typeof githubToken === 'string' ? githubToken : null;

    try {
      // Determine the final project path
      if (githubUrl) {
        // Clone repository (to projectPath if provided, otherwise generate path)
        const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);
        githubTokenForDiagnostics = tokenToUse;

        let targetPath;
        if (projectPath) {
          targetPath = projectPath;
        } else {
          // Generate a unique path for cloning
          const repoHash = crypto.createHash('md5').update(githubUrl + Date.now()).digest('hex');
          targetPath = path.join(os.homedir(), '.claude', 'external-projects', repoHash);
        }

        const clonedProject = await cloneGitHubRepo(githubUrl.trim(), tokenToUse, targetPath);
        finalProjectPath = clonedProject.path;
        clonedProjectCreated = clonedProject.created;
      } else {
        // Use existing project path
        finalProjectPath = normalizeProjectPath(path.resolve(projectPath));

        // Verify the path exists
        try {
          await fs.access(finalProjectPath);
        } catch (error) {
          throw new Error(`Project path does not exist: ${finalProjectPath}`);
        }
      }

      finalProjectPath = normalizeProjectPath(finalProjectPath);

      // The legacy API-key endpoint can run a provider and then create/push a
      // branch. Admit it through the same execution snapshot as WebSocket
      // turns so shared Git commits receive Human-Actor and receipt trailers.
      execution = dependencies.executionAttribution?.beginExecution({
        userId: req.user.id,
        sessionId: sessionId || null,
        provider,
        projectPath: finalProjectPath,
      }) ?? null;

      // Register project path in DB (or reuse existing active registration)
      const registrationResult = projectsDb.createProjectPath(finalProjectPath, null);
      if (registrationResult.outcome === 'active_conflict') {
        console.log('Project registration already exists for:', finalProjectPath);
      } else {
        console.log('Project registered:', registrationResult.project);
      }

      // Set up writer based on streaming mode
      if (stream) {
        // Set up SSE headers for streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

        writer = new SSEStreamWriter(res, req.user.id);

        // Send initial status
        writer.send({
          type: 'status',
          message: githubUrl ? 'Repository cloned and session started' : 'Session started',
          projectPath: finalProjectPath
        });
      } else {
        // Non-streaming mode: collect messages
        writer = new ResponseCollector(req.user.id);

        // Collect initial status message
        writer.send({
          type: 'status',
          message: githubUrl ? 'Repository cloned and session started' : 'Session started',
          projectPath: finalProjectPath
        });
      }

      const codexModels = await providerModelsService.getProviderModels('codex');
      const opencodeModels = await providerModelsService.getProviderModels('opencode');

      // Start the appropriate session
      if (provider === 'claude') {
        console.log('🤖 Starting Claude SDK session');

        await queryClaudeSDK(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: sessionId || null,
          model: model,
          effort,
          executionEnvironment: execution?.environment,
          permissionMode: 'bypassPermissions' // Bypass all permissions for API calls
        }, writer);

      } else if (provider === 'cursor') {
        console.log('🖱️ Starting Cursor CLI session');

        await spawnCursor(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: sessionId || null,
          model: model || undefined,
          executionEnvironment: execution?.environment,
          skipPermissions: true // Bypass permissions for Cursor
        }, writer);
      } else if (provider === 'codex') {
        console.log('🤖 Starting Codex SDK session');

        await queryCodex(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: sessionId || null,
          model: model || codexModels.DEFAULT,
          effort,
          executionEnvironment: execution?.environment,
          permissionMode: 'bypassPermissions'
        }, writer);
      } else if (provider === 'opencode') {
        console.log('Starting OpenCode CLI session');

        await spawnOpenCode(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: sessionId || null,
          model: model || opencodeModels.DEFAULT,
          effort,
          executionEnvironment: execution?.environment,
          permissionMode: 'bypassPermissions' // Agent runs are non-interactive, like the other providers above
        }, writer);
      }

      // Handle GitHub branch and PR creation after successful agent completion
      let branchInfo = null;
      let prInfo = null;

      if (createBranch || createPR) {
        try {
          console.log('🔄 Starting GitHub branch/PR creation workflow...');

          // Get GitHub token
          const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);
          githubTokenForDiagnostics = tokenToUse;

          if (!tokenToUse) {
            throw new Error('GitHub token required for branch/PR creation. Please configure a GitHub token in settings.');
          }

          // Initialize Octokit
          const octokit = new Octokit({ auth: tokenToUse });

          // Get GitHub URL - either from parameter or from git remote
          let repoUrl = githubUrl;
          if (!repoUrl) {
            console.log('🔍 Getting GitHub URL from git remote...');
            try {
              repoUrl = await getGitRemoteUrl(finalProjectPath);
              console.log(`✅ Found GitHub remote: ${sanitizeAgentDiagnostic(repoUrl, githubTokenForDiagnostics)}`);
            } catch (error) {
              throw new Error(
                `Failed to get GitHub remote URL: ${sanitizeAgentDiagnostic(error?.message ?? error)}`,
              );
            }
          }

          // Parse GitHub URL to get owner and repo
          const { owner, repo } = parseGitHubUrl(repoUrl);
          console.log(`📦 Repository: ${owner}/${repo}`);

          // Use provided branch name or auto-generate from message
          const finalBranchName = branchName || autogenerateBranchName(message);
          if (branchName) {
            console.log(`🌿 Using provided branch name: ${finalBranchName}`);

            // Validate custom branch name
            const validation = validateBranchName(finalBranchName);
            if (!validation.valid) {
              throw new Error(`Invalid branch name: ${validation.error}`);
            }
          } else {
            console.log(`🌿 Auto-generated branch name: ${finalBranchName}`);
          }

          if (createBranch) {
            // Create and checkout the new branch locally
            console.log('🔄 Creating local branch...');
            const checkoutProcess = spawn('git', ['checkout', '-b', finalBranchName], {
              cwd: finalProjectPath,
              stdio: 'pipe'
            });

            await new Promise((resolve, reject) => {
              let stderr = '';
              checkoutProcess.stderr.on('data', (data) => { stderr += data.toString(); });
              checkoutProcess.on('close', (code) => {
                if (code === 0) {
                  console.log(`✅ Created and checked out local branch '${finalBranchName}'`);
                  resolve();
                } else {
                  // Branch might already exist locally, try to checkout
                  if (stderr.includes('already exists')) {
                    console.log(`ℹ️ Branch '${finalBranchName}' already exists locally, checking out...`);
                    const checkoutExisting = spawn('git', ['checkout', finalBranchName], {
                      cwd: finalProjectPath,
                      stdio: 'pipe'
                    });
                    checkoutExisting.on('close', (checkoutCode) => {
                      if (checkoutCode === 0) {
                        console.log(`✅ Checked out existing branch '${finalBranchName}'`);
                        resolve();
                      } else {
                        reject(new Error(
                          `Failed to checkout existing branch: ${sanitizeAgentDiagnostic(stderr)}`,
                        ));
                      }
                    });
                  } else {
                    reject(new Error(
                      `Failed to create branch: ${sanitizeAgentDiagnostic(stderr)}`,
                    ));
                  }
                }
              });
            });

            // Push the branch to remote
            console.log('🔄 Pushing branch to remote...');
            const pushProcess = spawn('git', ['push', '-u', 'origin', finalBranchName], {
              cwd: finalProjectPath,
              stdio: 'pipe'
            });

            await new Promise((resolve, reject) => {
              let stderr = '';
              let stdout = '';
              pushProcess.stdout.on('data', (data) => { stdout += data.toString(); });
              pushProcess.stderr.on('data', (data) => { stderr += data.toString(); });
              pushProcess.on('close', (code) => {
                if (code === 0) {
                  console.log(`✅ Pushed branch '${finalBranchName}' to remote`);
                  resolve();
                } else {
                  // Check if branch exists on remote but has different commits
                  if (stderr.includes('already exists') || stderr.includes('up-to-date')) {
                    console.log(`ℹ️ Branch '${finalBranchName}' already exists on remote, using existing branch`);
                    resolve();
                  } else {
                    reject(new Error(
                      `Failed to push branch: ${sanitizeAgentDiagnostic(stderr)}`,
                    ));
                  }
                }
              });
            });

            branchInfo = {
              name: finalBranchName,
              url: `https://github.com/${owner}/${repo}/tree/${finalBranchName}`
            };
          }

          if (createPR) {
            // Get commit messages to generate PR description
            console.log('🔄 Generating PR title and description...');
            const commitMessages = await getCommitMessages(finalProjectPath, 5);

            // Use the first commit message as the PR title, or fallback to the agent message
            const prTitle = commitMessages.length > 0 ? commitMessages[0] : message;

            // Generate PR body from commit messages
            let prBody = '## Changes\n\n';
            if (commitMessages.length > 0) {
              prBody += commitMessages.map(msg => `- ${msg}`).join('\n');
            } else {
              prBody += `Agent task: ${message}`;
            }
            prBody += '\n\n---\n*This pull request was automatically created by CloudCLI.ai Agent.*';

            console.log(`📝 PR Title: ${prTitle}`);

            // Create the pull request
            console.log('🔄 Creating pull request...');
            prInfo = await createGitHubPR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
          }

          // Send branch/PR info in response
          if (stream) {
            if (branchInfo) {
              writer.send({
                type: 'github-branch',
                branch: branchInfo
              });
            }
            if (prInfo) {
              writer.send({
                type: 'github-pr',
                pullRequest: prInfo
              });
            }
          }

        } catch (error) {
          const safeErrorMessage = sanitizeAgentDiagnostic(
            error?.message ?? error,
            githubTokenForDiagnostics,
          );
          console.error('❌ GitHub branch/PR creation error:', safeErrorMessage);

          // Send error but don't fail the entire request
          if (stream) {
            writer.send({
              type: 'github-error',
              error: safeErrorMessage
            });
          }
          // Store error info for non-streaming response
          if (!stream) {
            branchInfo = { error: safeErrorMessage };
            prInfo = { error: safeErrorMessage };
          }
        }
      }

      // Handle response based on streaming mode
      if (stream) {
        // Streaming mode: end the SSE stream
        writer.end();
      } else {
        // Non-streaming mode: send filtered messages and token summary as JSON
        const assistantMessages = writer.getAssistantMessages();
        const tokenSummary = writer.getTotalTokens();

        const response = {
          success: true,
          sessionId: writer.getSessionId(),
          messages: assistantMessages,
          tokens: tokenSummary,
          projectPath: finalProjectPath
        };

        // Add branch/PR info if created
        if (branchInfo) {
          response.branch = branchInfo;
        }
        if (prInfo) {
          response.pullRequest = prInfo;
        }

        res.json(response);
      }

      // Clean up if requested
      if (cleanup && githubUrl && clonedProjectCreated) {
        // Only cleanup if we cloned a repo (not for existing project paths)
        const sessionIdForCleanup = writer.getSessionId();
        setTimeout(() => {
          cleanupProject(finalProjectPath, sessionIdForCleanup);
        }, 5000);
      }

      if (execution) {
        dependencies.executionAttribution?.completeExecution(execution.runId, 'succeeded');
      }

    } catch (error) {
      const safeErrorMessage = sanitizeAgentDiagnostic(
        error?.message ?? error,
        githubTokenForDiagnostics,
      );
      console.error('❌ External session error:', safeErrorMessage);

      if (execution) {
        dependencies.executionAttribution?.completeExecution(execution.runId, 'failed');
      }

      // Clean up on error
      if (finalProjectPath && cleanup && githubUrl && clonedProjectCreated) {
        const sessionIdForCleanup = writer ? writer.getSessionId() : null;
        cleanupProject(finalProjectPath, sessionIdForCleanup);
      }

      if (stream) {
        // For streaming, send error event and stop
        if (!writer) {
          // Set up SSE headers if not already done
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          writer = new SSEStreamWriter(res, req.user.id);
        }

        if (!res.writableEnded) {
          writer.send({
            type: 'error',
            error: safeErrorMessage,
            message: `Failed: ${safeErrorMessage}`
          });
          writer.end();
        }
      } else if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: safeErrorMessage
        });
      }
    }
  });

  return router;
}
