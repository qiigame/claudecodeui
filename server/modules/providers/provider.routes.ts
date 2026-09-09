import express, { type NextFunction, type Request, type Response } from 'express';

import {
  collaborationService,
  isIdentityRegistryRequired,
} from '@/modules/collaboration/index.js';
import { projectsDb } from '@/modules/database/index.js';
import {
  captureDeploymentPolicy,
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  resolveCanonicalPath,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { sessionWorkspaceService } from '@/modules/worktrees/index.js';
import type {
  CodexMcpToolsApprovalMode,
  CustomProviderModelInput,
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderMcpServer,
  ProviderSkillCreateFile,
  ProviderSkillCreateInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import {
  AppError,
  asyncHandler,
  CODEX_MCP_TOOLS_APPROVAL_MODES,
  createApiSuccessResponse,
  isCodexMcpToolsApprovalMode,
  readAuthenticatedHttpUserId,
  normalizeProjectPath,
} from '@/shared/utils.js';

type DeploymentPolicyRequest = Request & {
  deploymentPolicy?: DeploymentPolicy;
};

const REDACTED_MCP_SECRET = '[redacted]';
const MCP_SECRET_OPTION_PATTERN = /(?:token|secret|password|passwd|api[-_]?key|authorization|credential|cookie)/i;
const MCP_SECRET_INLINE_PATTERN = /(?:bearer|basic)\s+\S+|(?:authorization|x[-_]?api[-_]?key|api[-_]?key|token|secret|password|cookie)\s*[:=]\s*\S+/i;

/**
 * Provider MCP configuration is a read endpoint, but its native shape can
 * contain bearer tokens and API keys.  Never return those values to a managed
 * DingTalk actor unless the actor is an explicitly trusted settings admin.
 * Keeping the keys (with a stable marker) lets the settings UI explain why a
 * value is present without turning GET /mcp/servers into a credential oracle.
 */
export function redactProviderMcpServerSecrets(server: ProviderMcpServer): ProviderMcpServer {
  const redactMap = (value?: Record<string, string>): Record<string, string> | undefined => {
    if (!value) {
      return value;
    }
    return Object.fromEntries(Object.keys(value).map((key) => [key, REDACTED_MCP_SECRET]));
  };

  const redactArgs = (args?: string[]): string[] | undefined => {
    if (!args) {
      return args;
    }
    const redacted: string[] = [];
    let redactNext = false;
    for (const arg of args) {
      if (redactNext) {
        redacted.push(REDACTED_MCP_SECRET);
        redactNext = false;
        continue;
      }
      const normalized = String(arg);
      const separator = normalized.indexOf('=');
      const optionName = separator >= 0 ? normalized.slice(0, separator) : normalized;
      const isHeaderOption = /^(?:--header|-H)$/i.test(optionName);
      if (MCP_SECRET_INLINE_PATTERN.test(normalized)) {
        redacted.push(REDACTED_MCP_SECRET);
        redactNext = false;
        continue;
      }
      if (MCP_SECRET_OPTION_PATTERN.test(optionName) || isHeaderOption) {
        redacted.push(separator >= 0 ? `${optionName}=${REDACTED_MCP_SECRET}` : normalized);
        redactNext = separator < 0;
        continue;
      }
      redacted.push(normalized);
    }
    return redacted;
  };

  const redactUrl = (url?: string): string | undefined => {
    if (!url) {
      return url;
    }
    try {
      const parsed = new URL(url);
      // Userinfo is never useful to a catalog reader and may contain a secret.
      parsed.username = '';
      parsed.password = '';
      for (const key of Array.from(parsed.searchParams.keys())) {
        parsed.searchParams.set(key, REDACTED_MCP_SECRET);
      }
      parsed.hash = '';
      return parsed.toString();
    } catch {
      // Invalid/native URLs are still safe to expose only as a redacted marker.
      return REDACTED_MCP_SECRET;
    }
  };

  return {
    ...server,
    args: redactArgs(server.args),
    env: redactMap(server.env),
    url: redactUrl(server.url),
    headers: redactMap(server.headers),
    envHttpHeaders: redactMap(server.envHttpHeaders),
  };
}

function requestMayViewMcpSecrets(request: Request, options: ResolvedProviderRouterOptions): boolean {
  const policy = resolveDeploymentPolicy(options, request);
  const requestUser = (request as Request & {
    user?: { actor?: { provider?: string } | null };
  }).user;
  const managedProfile = policy.profile === 'platform'
    || policy.profile === 'production'
    || policy.profile === 'product-qa-readonly'
    // A local developer profile can still be backed by DingTalk SSO. Treat
    // that request as managed too; profile names alone must not reopen the
    // credential oracle for a pending/ambiguous actor.
    || requestUser?.actor?.provider === 'dingtalk'
    || isIdentityRegistryRequired();
  if (!managedProfile) {
    return true;
  }

  const user = (request as Request & {
    user?: {
      actor?: { provider?: string; personId?: string | null; identityStatus?: string } | null;
      permissions?: { manageSettings?: boolean };
    };
  }).user;
  return user?.actor?.provider === 'dingtalk'
    && Boolean(user.actor.personId)
    && user.actor.identityStatus === 'verified'
    && user.permissions?.manageSettings === true;
}

export type ProviderRouterOptions = {
  /** Optional policy override used by composition roots and deterministic tests. */
  deploymentPolicy?: DeploymentPolicy | (() => DeploymentPolicy);
};

/** Internal route options after the policy source has been captured at startup. */
type ResolvedProviderRouterOptions = Omit<ProviderRouterOptions, 'deploymentPolicy'> & {
  deploymentPolicy: DeploymentPolicy;
};

/**
 * Provider catalog/MCP/skill mutations are deployment configuration writes.
 * Keep the check in the route module as a defense in depth for callers that
 * mount this router without the application-wide policy middleware. Existing
 * developer deployments retain the historical `provider-write` capability;
 * the dotted name is the canonical name used by the product-qa profile.
 */
function createCapabilityGuard(
  options: ResolvedProviderRouterOptions,
  capabilities: readonly string[],
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, _response, next) => {
    const policy = resolveDeploymentPolicy(options, request);
    const allowed = policy.profile !== 'product-qa-readonly'
      && capabilities.some((capability) => hasDeploymentCapability(policy, capability));
    if (!allowed) {
      next(new AppError('Provider configuration changes are disabled for this deployment.', {
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        statusCode: 403,
        details: { profile: policy.profile, capabilities },
      }));
      return;
    }
    next();
  };
}

/**
 * Requires one or more read/write capabilities on the resolved deployment.
 * This is kept separate from `createCapabilityGuard`: provider configuration
 * writes have a legacy compatibility rule, while reads and session metadata
 * must honor the exact capability requested by the route.
 */
function createRequiredCapabilityGuard(
  options: ResolvedProviderRouterOptions,
  capabilities: readonly string[],
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, _response, next) => {
    const policy = resolveDeploymentPolicy(options, request);
    const allowed = capabilities.every((capability) => hasDeploymentCapability(policy, capability));
    if (!allowed) {
      next(new AppError('This operation is disabled for the deployment.', {
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        statusCode: 403,
        details: { profile: policy.profile, capabilities },
      }));
      return;
    }
    next();
  };
}

function resolveDeploymentPolicy(
  options: ResolvedProviderRouterOptions,
  request: Request,
): DeploymentPolicy {
  // `options.deploymentPolicy` is always the factory-captured snapshot.  A
  // trusted composition middleware may attach a request snapshot (normally
  // the same object) and takes precedence; no request path parses process.env.
  return (request as DeploymentPolicyRequest).deploymentPolicy ?? options.deploymentPolicy;
}

/**
 * Read-only callers may ask the provider catalog to inspect a project-local
 * skills/MCP file.  Resolve that path through the registered project table
 * instead of allowing an arbitrary absolute path (which would turn these
 * otherwise harmless GET endpoints into a host-file/config oracle).  Local
 * developer deployments retain the historical ability to inspect an
 * unregistered checkout, which is useful while onboarding a new project.
 */
async function assertReadonlyWorkspacePath(
  options: ResolvedProviderRouterOptions,
  request: Request,
  workspacePath: string | undefined,
): Promise<string | undefined> {
  if (!workspacePath) {
    return undefined;
  }

  const policy = resolveDeploymentPolicy(options, request);
  const requestUser = (request as Request & {
    user?: { actor?: { provider?: string } | null };
  }).user;
  const managedIdentityRequest = requestUser?.actor?.provider === 'dingtalk'
    || policy.profile === 'platform'
    || policy.profile === 'production'
    || policy.profile === 'product-qa-readonly';
  if (!isDeploymentReadOnly(policy) && !managedIdentityRequest) {
    return workspacePath;
  }

  const normalizedPath = normalizeProjectPath(workspacePath);
  if (!normalizedPath) {
    throw new AppError('workspacePath is invalid.', {
      code: 'INVALID_WORKSPACE_PATH',
      statusCode: 400,
    });
  }

  const project = projectsDb.getProjectPath(normalizedPath);
  if (!project) {
    throw new AppError('workspacePath must refer to a registered project.', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  // The project row is authoritative, but canonicalize the existing path to
  // reject a symlink that was changed after registration. Return the
  // canonical path only when it still resolves to the registered directory;
  // otherwise a legacy symlink row could turn this GET into an unrelated
  // host-directory oracle.
  let canonicalPath: string;
  try {
    canonicalPath = await resolveCanonicalPath(project.project_path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new AppError('Registered workspace path is no longer available.', {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }
    throw error;
  }

  if (normalizeProjectPath(canonicalPath) !== normalizeProjectPath(project.project_path)) {
    throw new AppError('Registered workspace path is not canonical.', {
      code: 'PATH_OUTSIDE_CANONICAL_ROOT',
      statusCode: 403,
    });
  }
  return canonicalPath;
}

export function createProviderRouter(options: ProviderRouterOptions = {}): express.Router {
const resolvedOptions: ResolvedProviderRouterOptions = {
  ...options,
  deploymentPolicy: captureDeploymentPolicy(options.deploymentPolicy),
};
const router = express.Router();
const providerWriteGuard = createCapabilityGuard(resolvedOptions, ['provider.write', 'provider-write']);
const mcpWriteGuard = createCapabilityGuard(resolvedOptions, ['mcp.write', 'mcp-write', 'provider.write', 'provider-write']);
const providerRuntimeReadGuard = createRequiredCapabilityGuard(resolvedOptions, [
  DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
]);
const skillReadGuard = createRequiredCapabilityGuard(resolvedOptions, [
  DEPLOYMENT_CAPABILITIES.SKILL_READ,
]);
const mcpReadGuard = createRequiredCapabilityGuard(resolvedOptions, [
  DEPLOYMENT_CAPABILITIES.MCP_READ,
]);
const sessionReadGuard = createRequiredCapabilityGuard(resolvedOptions, [
  DEPLOYMENT_CAPABILITIES.SESSION_READ,
]);
const sessionWriteGuard = createRequiredCapabilityGuard(resolvedOptions, [
  DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
]);
const sessionFilesystemWriteGuard = createRequiredCapabilityGuard(resolvedOptions, [
  DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
  DEPLOYMENT_CAPABILITIES.FILE_WRITE,
]);

  // Apply mutation guards before route matching. Keeping this matrix here
  // makes newly mounted routers safe even when they are not mounted through
  // server/index.ts (as happens in unit tests and lightweight integrations).
  router.use((request, _response, next) => {
    const method = request.method.toUpperCase();
    // Express matches routes case-insensitively by default. Normalize the
    // path before applying this pre-route capability matrix; otherwise a
    // request such as `/CLAUDE/MODELS` would reach the same mutation handler
    // while bypassing the lowercase regex guards in a read-only deployment.
    const routePath = (request.path.replace(/\/+$/, '') || '/').toLowerCase();

    if (
      (method === 'POST' && routePath === '/sessions')
      || (method === 'POST' && /^\/sessions\/[^/]+\/restore$/.test(routePath))
      || (method === 'PUT' && /^\/sessions\/[^/]+$/.test(routePath))
      || (method === 'POST' && /^\/[^/]+\/sessions\/[^/]+\/active-(model|effort)$/.test(routePath))
    ) {
      sessionWriteGuard(request, _response, next);
      return;
    }

    if (method === 'POST' && /^\/sessions\/[^/]+\/fork$/.test(routePath)) {
      // A provider fork writes a new transcript/thread, so metadata permission
      // alone is insufficient in product/QA mode.
      sessionFilesystemWriteGuard(request, _response, next);
      return;
    }

    if (method === 'DELETE' && /^\/sessions\/[^/]+$/.test(routePath)) {
      // Archive and explicit metadata-only deletion are safe.  The route's
      // default for `force=true` is disk deletion, therefore inspect the query
      // before any handler can unlink provider transcripts.
      sessionWriteGuard(request, _response, (error?: unknown) => {
        if (error) {
          next(error);
          return;
        }
        const force = String(request.query.force ?? '').toLowerCase() === 'true';
        const deletedFromDisk = request.query.deletedFromDisk === undefined
          ? force
          : String(request.query.deletedFromDisk).toLowerCase() === 'true';
        if (force && deletedFromDisk) {
          sessionFilesystemWriteGuard(request, _response, next);
          return;
        }
        next();
      });
      return;
    }

    if (
      (method === 'POST' && /^\/[^/]+\/models$/.test(routePath))
      || (method === 'PATCH' && /^\/[^/]+\/models\/[^/]+$/.test(routePath))
      || (method === 'DELETE' && /^\/[^/]+\/models\/[^/]+$/.test(routePath))
      || (method === 'POST' && /^\/[^/]+\/skills$/.test(routePath))
      || (method === 'DELETE' && /^\/[^/]+\/skills\/[^/]+$/.test(routePath))
    ) {
      providerWriteGuard(request, _response, next);
      return;
    }

    if (
      (method === 'POST' && /^\/[^/]+\/mcp\/servers$/.test(routePath))
      || (method === 'DELETE' && /^\/[^/]+\/mcp\/servers\/[^/]+$/.test(routePath))
      || (method === 'POST' && routePath === '/mcp/servers/global')
    ) {
      mcpWriteGuard(request, _response, next);
      return;
    }

    next();
  });

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

const readOptionalQueryString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const parseOptionalBooleanQuery = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new AppError(`${name} must be "true" or "false".`, {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

const parseMcpTransport = (value: unknown): McpTransport => {
  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    throw new AppError('transport is required.', {
      code: 'MCP_TRANSPORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalized === 'stdio' || normalized === 'http' || normalized === 'sse') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP transport "${normalized}".`, {
    code: 'INVALID_MCP_TRANSPORT',
    statusCode: 400,
  });
};

const parseCodexMcpToolsApprovalMode = (
  value: unknown,
): CodexMcpToolsApprovalMode | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isCodexMcpToolsApprovalMode(value)) {
    return value;
  }

  throw new AppError(
    `defaultToolsApprovalMode must be one of: ${CODEX_MCP_TOOLS_APPROVAL_MODES.join(', ')}.`,
    {
      code: 'INVALID_MCP_TOOLS_APPROVAL_MODE',
      statusCode: 400,
    },
  );
};

const parseMcpUpsertPayload = (payload: unknown): UpsertProviderMcpServerInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const name = readOptionalQueryString(body.name);
  if (!name) {
    throw new AppError('name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const transport = parseMcpTransport(body.transport);
  const scope = parseMcpScope(body.scope);
  const workspacePath = readOptionalQueryString(body.workspacePath);

  return {
    name,
    transport,
    scope,
    workspacePath,
    command: readOptionalQueryString(body.command),
    args: Array.isArray(body.args) ? body.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
    env: typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    cwd: readOptionalQueryString(body.cwd),
    url: readOptionalQueryString(body.url),
    headers: typeof body.headers === 'object' && body.headers !== null
      ? Object.fromEntries(
        Object.entries(body.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    bearerTokenEnvVar: readOptionalQueryString(body.bearerTokenEnvVar),
    envHttpHeaders: typeof body.envHttpHeaders === 'object' && body.envHttpHeaders !== null
      ? Object.fromEntries(
        Object.entries(body.envHttpHeaders as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    defaultToolsApprovalMode: parseCodexMcpToolsApprovalMode(body.defaultToolsApprovalMode),
  };
};

const parseProviderSkillCreatePayload = (payload: unknown): ProviderSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : typeof body.content === 'string'
      ? [{
          content: body.content,
          directoryName: body.directoryName,
          fileName: body.fileName,
          files: body.files,
        }]
      : null;

  if (!rawEntries || rawEntries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROVIDER_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(`Skill entry ${index + 1} must be an object.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    const directoryName = readOptionalQueryString(record.directoryName);
    const fileName = readOptionalQueryString(record.fileName);
    const rawFiles = record.files;

    if (!content.trim()) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      throw new AppError(`Skill entry ${index + 1} files must be an array.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const files: ProviderSkillCreateFile[] | undefined = rawFiles?.map((file, fileIndex) => {
      if (!file || typeof file !== 'object') {
        throw new AppError(`Skill entry ${index + 1} file ${fileIndex + 1} must be an object.`, {
          code: 'INVALID_REQUEST_BODY',
          statusCode: 400,
        });
      }

      const fileRecord = file as Record<string, unknown>;
      const relativePath = readOptionalQueryString(fileRecord.relativePath);
      const fileContent = typeof fileRecord.content === 'string' ? fileRecord.content : null;
      const encoding = fileRecord.encoding === 'utf8' || fileRecord.encoding === 'base64'
        ? fileRecord.encoding
        : null;

      if (!relativePath || fileContent === null || !encoding) {
        throw new AppError(
          `Skill entry ${index + 1} file ${fileIndex + 1} requires relativePath, content, and encoding.`,
          {
            code: 'INVALID_REQUEST_BODY',
            statusCode: 400,
          },
        );
      }

      return {
        relativePath,
        content: fileContent,
        encoding,
      };
    });

    return {
      content,
      directoryName,
      fileName,
      files,
    };
  });

  return { entries };
};

const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'cursor'
    || normalized === 'opencode'
  ) {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

/** Both fields are optional: an empty body forks the whole conversation. */
const parseSessionForkPayload = (payload: unknown): { upToAnchorId?: string; title?: string } => {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const upToAnchorId = typeof body.upToAnchorId === 'string' ? body.upToAnchorId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  return {
    ...(upToAnchorId ? { upToAnchorId } : {}),
    ...(title ? { title } : {}),
  };
};

const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

const parseSessionSearchQuery = (value: unknown): string => {
  const query = readOptionalQueryString(value) ?? '';
  if (query.length < 2) {
    throw new AppError('Query must be at least 2 characters', {
      code: 'INVALID_SEARCH_QUERY',
      statusCode: 400,
    });
  }

  return query;
};

const parseSessionSearchLimit = (value: unknown): number => {
  const raw = readOptionalQueryString(value);
  if (!raw) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('limit must be a valid integer.', {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return Math.max(1, Math.min(parsed, 100));
};

const parseBoundedIntegerQuery = <T extends number | null>(
  value: unknown,
  name: string,
  fallback: T,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | T => {
  const raw = readOptionalQueryString(value);
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError(`${name} must be an integer between ${minimum} and ${maximum}.`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsed;
};

const parseSessionModelPayload = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return model;
};

const parseSessionEffortPayload = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const effort = readOptionalQueryString(body.effort);
  if (!effort) {
    throw new AppError('effort is required.', {
      code: 'EFFORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (effort.length > 32) {
    throw new AppError('effort must be 32 characters or fewer.', {
      code: 'INVALID_EFFORT',
      statusCode: 400,
    });
  }

  return effort;
};

const parseModelRecordId = (value: unknown): number => {
  const rawRecordId = readPathParam(value, 'recordId').trim();
  if (!/^\d+$/.test(rawRecordId)) {
    throw new AppError('recordId must be a positive integer.', {
      code: 'INVALID_MODEL_RECORD_ID',
      statusCode: 400,
    });
  }

  const recordId = Number.parseInt(rawRecordId, 10);
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    throw new AppError('recordId must be a positive integer.', {
      code: 'INVALID_MODEL_RECORD_ID',
      statusCode: 400,
    });
  }

  return recordId;
};

const parseCustomProviderModelPayload = (payload: unknown): CustomProviderModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  const id = readOptionalQueryString(body.id);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_NAME_REQUIRED',
      statusCode: 400,
    });
  }
  if (!id) {
    throw new AppError('id is required.', {
      code: 'MODEL_ID_REQUIRED',
      statusCode: 400,
    });
  }
  if (model.length > 80) {
    throw new AppError('model must be 80 characters or fewer.', {
      code: 'MODEL_NAME_TOO_LONG',
      statusCode: 400,
    });
  }
  if (id.length > 200 || /\s/.test(id)) {
    throw new AppError('id must be 200 characters or fewer and cannot contain whitespace.', {
      code: 'INVALID_MODEL_ID',
      statusCode: 400,
    });
  }

  return { model, id };
};

router.get(
  '/:provider/auth/status',
  providerRuntimeReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const status = await providerAuthService.getProviderAuthStatus(provider);
    res.json(createApiSuccessResponse(status));
  }),
);

router.get(
  '/:provider/models',
  providerRuntimeReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const models = await providerModelsService.getProviderModels(provider);
    res.json(createApiSuccessResponse({ provider, models }));
  }),
);

router.post(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseCustomProviderModelPayload(req.body);
    const result = await providerModelsService.createCustomModel(provider, input);
    res.status(201).json(createApiSuccessResponse({ provider, ...result }));
  }),
);

router.patch(
  '/:provider/models/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const recordId = parseModelRecordId(req.params.recordId);
    const input = parseCustomProviderModelPayload(req.body);
    const result = await providerModelsService.updateCustomModel(provider, recordId, input);
    res.json(createApiSuccessResponse({ provider, ...result }));
  }),
);

router.delete(
  '/:provider/models/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const recordId = parseModelRecordId(req.params.recordId);
    const result = await providerModelsService.deleteCustomModel(provider, recordId);
    res.json(createApiSuccessResponse({ provider, ...result }));
  }),
);

/**
 * Reports which model one session is using. `requestedModel` lets the client
 * pass the default it would otherwise send, so a session that has not been
 * sent on yet resolves to that instead of the catalog default.
 */
router.get(
  '/:provider/sessions/:sessionId/active-model',
  providerRuntimeReadGuard,
  sessionReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const requestedModel = readOptionalQueryString(req.query.requestedModel);
    const result = await providerModelsService.resolveSessionModel(provider, {
      sessionId,
      requestedModel,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const model = parseSessionModelPayload(req.body);
    const stored = providerModelsService.setSessionModel(provider, sessionId, model);
    // A session row only exists once the gateway has allocated one. Report the
    // selection back either way so the client can hold it until the first send.
    res.json(createApiSuccessResponse(
      stored ?? { provider, sessionId, model, effort: null, source: 'session' as const },
    ));
  }),
);

/** Records the reasoning-effort choice for one app session. */
router.post(
  '/:provider/sessions/:sessionId/active-effort',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const effort = parseSessionEffortPayload(req.body);
    const stored = providerModelsService.setSessionEffort(provider, sessionId, effort);
    // Mirror active-model behavior for a composer that picked an effort just
    // before the session gateway created its row.
    res.json(createApiSuccessResponse(
      stored ?? { provider, sessionId, effort, source: 'session' as const },
    ));
  }),
);

// ----------------- Skills routes -----------------
router.get(
  '/:provider/skills',
  skillReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const requestedWorkspacePath = readOptionalQueryString(req.query.workspacePath);
    const workspacePath = await assertReadonlyWorkspacePath(
      resolvedOptions,
      req,
      requestedWorkspacePath,
    );
    const skills = await providerSkillsService.listProviderSkills(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.post(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseProviderSkillCreatePayload(req.body);
    const skills = await providerSkillsService.addProviderSkills(provider, input);
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.delete(
  '/:provider/skills/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const result = await providerSkillsService.removeProviderSkill(provider, {
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- MCP routes -----------------
router.get(
  '/:provider/mcp/servers',
  mcpReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const requestedWorkspacePath = readOptionalQueryString(req.query.workspacePath);
    const workspacePath = await assertReadonlyWorkspacePath(
      resolvedOptions,
      req,
      requestedWorkspacePath,
    );
    const scope = parseMcpScope(req.query.scope);

    if (scope) {
      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, { workspacePath });
      const visibleServers = requestMayViewMcpSecrets(req, resolvedOptions)
        ? servers
        : servers.map(redactProviderMcpServerSecrets);
      res.json(createApiSuccessResponse({ provider, scope, servers: visibleServers }));
      return;
    }

    const groupedServers = await providerMcpService.listProviderMcpServers(provider, { workspacePath });
    const visibleScopes = requestMayViewMcpSecrets(req, resolvedOptions)
      ? groupedServers
      : Object.fromEntries(Object.entries(groupedServers).map(([scopeName, servers]) => [
        scopeName,
        servers.map(redactProviderMcpServerSecrets),
      ]));
    res.json(createApiSuccessResponse({ provider, scopes: visibleScopes }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    const server = await providerMcpService.upsertProviderMcpServer(provider, payload);
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const scope = parseMcpScope(req.query.scope);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/mcp/servers/global',
  asyncHandler(async (req: Request, res: Response) => {
    const payload = parseMcpUpsertPayload(req.body);
    if (payload.scope === 'local') {
      throw new AppError('Global MCP add supports only "user" or "project" scopes.', {
        code: 'INVALID_GLOBAL_MCP_SCOPE',
        statusCode: 400,
      });
    }

    const results = await providerMcpService.addMcpServerToAllProviders({
      ...payload,
      scope: payload.scope === 'user' ? 'user' : 'project',
    });
    res.status(201).json(createApiSuccessResponse({ results }));
  }),
);

router.get(
  '/capabilities',
  providerRuntimeReadGuard,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({
      providers: providerCapabilitiesService.listAllProviderCapabilities(),
    }));
  }),
);

router.get(
  '/:provider/capabilities',
  providerRuntimeReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    res.json(createApiSuccessResponse(
      providerCapabilitiesService.getProviderCapabilities(provider),
    ));
  }),
);

// ----------------- Session routes -----------------
/**
 * Session gateway entry point: allocates the stable app-facing session id for
 * a brand-new chat. The frontend must call this before the first `chat.send`
 * so the session id in the URL, the store, and the websocket all agree from
 * the very first message — there is no client-visible session-id handoff.
 */
router.post(
  '/sessions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = parseProvider(body.provider);
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : undefined;
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : '';
    const initialMessage = typeof body.initialMessage === 'string' ? body.initialMessage : '';
    const repositoryKeys = Array.isArray(body.repositoryKeys)
      ? body.repositoryKeys.filter((key): key is string => typeof key === 'string')
      : [];
    const userId = readAuthenticatedHttpUserId(req);
    const result = await sessionsService.createProjectSession({
      provider,
      projectId,
      projectPath,
      initialMessage,
      repositoryKeys,
      userId,
      // The deployment policy is attached by the composition root and cannot
      // be supplied by the browser.  Session creation uses it to skip
      // worktree planning/provisioning in product/QA read-only mode.
      deploymentPolicy: resolveDeploymentPolicy(resolvedOptions, req),
    }, sessionWorkspaceService);
    const attribution = collaborationService.recordSessionCreated(
      result.sessionId,
      userId,
    );
    res.status(201).json(createApiSuccessResponse({ ...result, attribution }));
  }),
);

router.get(
  '/sessions/running',
  sessionReadGuard,
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = sessionsService.listRunningSessions();
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/recent',
  sessionReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const limit = parseBoundedIntegerQuery(req.query.limit, 'limit', 40, 1, 100);
    const offset = parseBoundedIntegerQuery(req.query.offset, 'offset', 0, 0);
    const page = sessionsService.listRecentSessions(limit, offset);
    res.json(createApiSuccessResponse(page));
  }),
);

router.get(
  '/sessions/archived',
  sessionReadGuard,
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = sessionsService.listArchivedSessions();
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/:sessionId/provider-id',
  sessionReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const providerSessionId = sessionsService.getProviderSessionId(sessionId);
    res.json(createApiSuccessResponse({ sessionId: providerSessionId }));
  }),
);

router.get(
  '/sessions/:sessionId/token-usage',
  sessionReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await providerTokenUsageService.getSessionTokenUsage(
      sessionId,
      resolveDeploymentPolicy(resolvedOptions, req),
    );
    res.json(createApiSuccessResponse(result));
  }),
);

// Must stay registered after the static and session-specific routes so their
// literals never match the generic `:sessionId` parameter.
router.get(
  '/sessions/:sessionId',
  sessionReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.getSessionDetailsById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, {
      force,
      deletedFromDisk,
    }, resolveDeploymentPolicy(resolvedOptions, req));
    if (result.action === 'archived') {
      collaborationService.recordSessionAction(
        sessionId,
        readAuthenticatedHttpUserId(req),
        'archive',
      );
    }
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.restoreSessionById(sessionId);
    collaborationService.recordSessionAction(
      sessionId,
      readAuthenticatedHttpUserId(req),
      'restore',
    );
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/fork',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await sessionsService.forkSessionById(
      sessionId,
      parseSessionForkPayload(req.body),
      resolveDeploymentPolicy(resolvedOptions, req),
    );
    const userId = readAuthenticatedHttpUserId(req);
    collaborationService.recordSessionAction(sessionId, userId, 'fork');
    const attribution = collaborationService.recordSessionCreated(result.sessionId, userId);
    res.status(201).json(createApiSuccessResponse({ ...result, attribution }));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const result = sessionsService.renameSessionById(sessionId, summary);
    collaborationService.recordSessionAction(
      sessionId,
      readAuthenticatedHttpUserId(req),
      'rename',
    );
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/:sessionId/messages',
  sessionReadGuard,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const limit = parseBoundedIntegerQuery(req.query.limit, 'limit', null, 0);
    const offset = parseBoundedIntegerQuery(req.query.offset, 'offset', 0, 0);

    const result = await sessionsService.fetchHistory(sessionId, {
      limit,
      offset,
    }, resolveDeploymentPolicy(resolvedOptions, req));
    res.json(createApiSuccessResponse(result));
  }),
);

router.get('/search/sessions', sessionReadGuard, asyncHandler(async (req: Request, res: Response) => {
  const query = parseSessionSearchQuery(req.query.q);
  const limit = parseSessionSearchLimit(req.query.limit);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abortController = new AbortController();
  // IncomingMessage emits `close` after a normal request has been fully
  // consumed on current Node releases. Listening to it as an unconditional
  // disconnect aborts every completed GET search before the first result is
  // written. Treat only an unfinished response as a client disconnect; keep
  // the explicit `aborted` request event for an early transport abort.
  const markClientClosed = () => {
    if (res.writableEnded || closed) {
      return;
    }
    closed = true;
    abortController.abort();
  };
  req.on('aborted', markClientClosed);
  res.on('close', markClientClosed);

  try {
    await sessionConversationsSearchService.search({
      query,
      limit,
      signal: abortController.signal,
      onTitleResults: (titleResults) => {
        if (!closed) {
          res.write(`event: title-results\ndata: ${JSON.stringify({ titleResults })}\n\n`);
        }
      },
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }

        if (projectResult) {
          res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
          return;
        }

        res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
      },
    });

    if (!closed) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (error) {
    console.error('Error searching conversations:', error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
    }
  } finally {
    req.off('aborted', markClientClosed);
    res.off('close', markClientClosed);
    if (!closed) {
      res.end();
    }
  }
}));

  return router;
}

const router = createProviderRouter();

export default router;
