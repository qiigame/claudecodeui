// @ts-nocheck -- temporary while Taskmaster workflows are extracted into the injected service.
/**
 * TASKMASTER API ROUTES
 * ====================
 *
 * This module provides API endpoints for TaskMaster integration including:
 * - .taskmaster folder detection in project directories
 * - MCP server configuration detection
 * - TaskMaster state and metadata management
 */

import path from 'path';

import express, { type RequestHandler } from 'express';

import {
    captureDeploymentPolicy,
    DEPLOYMENT_CAPABILITIES,
    createDeploymentPolicyGuard,
    hasDeploymentCapability,
    isDeploymentReadOnly,
    type DeploymentPolicy,
    type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';

import type { createTaskmasterService } from './taskmaster.service.js';
// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution — required
// here since task-master/npx are .cmd shims on Windows.

type TaskmasterRouterDependencies = {
    fileSystem: typeof import('node:fs');
    fileSystemPromises: typeof import('node:fs/promises');
    spawnProcess: typeof import('cross-spawn').default;
    taskmasterCliCommand?: string;
    /** Optional deployment capability factory supplied by the composition root. */
    capabilityGuard?: (operation: string, policy?: DeploymentPolicy) => RequestHandler;
    /** Optional startup-resolved policy used by alternate mounts and tests. */
    deploymentPolicy?: DeploymentPolicySource;
    /** Optional logger; diagnostics are normalized before they reach it. */
    logger?: Pick<Console, 'error' | 'warn' | 'info'>;
    resolveProjectPathById(projectId: string): string | null;
    taskmasterService: ReturnType<typeof createTaskmasterService>;
};

const TASKMASTER_PUBLIC_FAILURE_MESSAGE = 'TaskMaster operation failed.';
const TASKMASTER_PROCESS_FAILURE_CODE = 'TASKMASTER_PROCESS_FAILED';
const TASKMASTER_UNEXPECTED_FAILURE_CODE = 'TASKMASTER_UNEXPECTED_ERROR';
const TASKMASTER_CLI_UNAVAILABLE_CODE = 'TASKMASTER_CLI_UNAVAILABLE';
const MAX_TASKMASTER_OUTPUT_BYTES = 8192;
const SAFE_TASKMASTER_STATUS_REASONS = new Set([
    'No Claude configuration file found',
    'task-master-ai not found in configured MCP servers',
]);

type TaskmasterProcessResult = {
    code: number | null;
    error?: unknown;
    stdoutBytes: number;
    stderrBytes: number;
};

function countTaskmasterOutput(currentBytes: number, chunk: unknown): number {
    const chunkBytes = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(typeof chunk === 'string' ? chunk : String(chunk ?? ''));
    // We only need bounded accounting.  Keeping `MAX + 1` distinguishes a
    // capped stream from an exact MAX-byte stream without retaining content.
    return Math.min(MAX_TASKMASTER_OUTPUT_BYTES + 1, currentBytes + chunkBytes);
}

function boundedTaskmasterText(chunk: unknown, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    if (typeof chunk === 'string') return chunk.slice(0, maxBytes);
    if (Buffer.isBuffer(chunk)) return chunk.subarray(0, maxBytes).toString('utf8');
    return String(chunk ?? '').slice(0, maxBytes);
}

function parseSafeTaskmasterVersion(output: string): string {
    const version = output.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
    return version ?? 'unknown';
}

/**
 * Converts an error's identity into a bounded, non-sensitive diagnostic token.
 * Error messages are deliberately excluded: CLIs and filesystem errors often
 * contain paths, command arguments, URLs, or credentials.
 */
function diagnosticToken(value: unknown, fallback = 'UNKNOWN'): string {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim();
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(normalized) ? normalized : fallback;
}

function safeErrorMetadata(error: unknown): Record<string, unknown> {
    if (!error || typeof error !== 'object') return { errorName: 'UNKNOWN' };
    const candidate = error as { name?: unknown; code?: unknown };
    return {
        errorName: diagnosticToken(candidate.name, 'Error'),
        ...(typeof candidate.code === 'number' && Number.isFinite(candidate.code)
            ? { errorCode: candidate.code }
            : typeof candidate.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(candidate.code)
                ? { errorCode: candidate.code }
                : {}),
    };
}

function safeProcessMetadata(result: TaskmasterProcessResult): Record<string, unknown> {
    return {
        exitCode: result.code,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        stdoutTruncated: result.stdoutBytes > MAX_TASKMASTER_OUTPUT_BYTES,
        stderrTruncated: result.stderrBytes > MAX_TASKMASTER_OUTPUT_BYTES,
        ...safeErrorMetadata(result.error),
    };
}

type PolicyAwareRequest = express.Request & {
    deploymentPolicy?: DeploymentPolicy;
};

/**
 * TaskMaster's status probe reads a Claude configuration file.  Its native
 * response includes executable paths, arbitrary command arguments, project
 * paths, and (for HTTP MCP servers) URLs that may carry bearer tokens in a
 * query string.  Those details are useful to a local developer, but are not
 * part of the product/QA read-only contract and would disclose the shared
 * service account's filesystem/configuration to every authenticated user.
 */
export function shouldRedactTaskmasterMcpStatus(request: PolicyAwareRequest): boolean {
    const policy = request?.deploymentPolicy;
    if (!policy) {
        // Standalone route consumers from before the deployment-policy split
        // retain their historical response shape. Production always attaches
        // the startup policy before this router is reached.
        return false;
    }

    if (isDeploymentReadOnly(policy)) {
        return true;
    }

    // A writable developer profile can still be fronted by DingTalk SSO. In
    // that hybrid mode only the verified settings administrator may inspect
    // provider configuration details; ordinary actors receive the same safe
    // summary as product/QA users.
    const user = (request as express.Request & {
        user?: {
            actor?: { provider?: unknown } | null;
            permissions?: { manageSettings?: unknown } | null;
        };
    }).user;
    return user?.actor?.provider === 'dingtalk'
        && user.permissions?.manageSettings !== true;
}

/**
 * Keeps only non-sensitive TaskMaster MCP facts for a managed/read-only
 * caller.  In particular, never echo `command`, `args`, `url`, `projectPath`,
 * `configPath`, or `availableServers`; any of those fields can reveal host
 * layout or inline credentials.  The shape is intentionally small and
 * forward-compatible: clients can still decide whether TaskMaster is
 * configured without receiving an execution recipe.
 */
export function redactTaskmasterMcpStatus(status: unknown): Record<string, unknown> {
    if (!status || typeof status !== 'object') {
        return {};
    }

    const source = status as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of ['hasMCPServer', 'isConfigured', 'hasApiKeys', 'hasConfig'] as const) {
        if (source[key] !== undefined) {
            safe[key] = Boolean(source[key]);
        }
    }

    if (typeof source.scope === 'string' && ['user', 'local', 'project'].includes(source.scope)) {
        safe.scope = source.scope;
    }
    if (typeof source.reason === 'string' && source.reason.trim()) {
        // Keep only the service's finite, documented reasons. A malformed
        // config or alternate service implementation must not turn this
        // convenience field into an arbitrary diagnostic channel.
        safe.reason = SAFE_TASKMASTER_STATUS_REASONS.has(source.reason)
            ? source.reason
            : 'TaskMaster status is unavailable.';
    }

    const config = source.config;
    if (config && typeof config === 'object') {
        const configRecord = config as Record<string, unknown>;
        const type = typeof configRecord.type === 'string'
            && ['stdio', 'http', 'unknown'].includes(configRecord.type)
            ? configRecord.type
            : 'unknown';
        const envVars = Array.isArray(configRecord.envVars)
            ? configRecord.envVars.filter((entry) => typeof entry === 'string').length
            : 0;
        safe.config = {
            type,
            hasCommand: typeof configRecord.command === 'string' && configRecord.command.length > 0,
            hasUrl: typeof configRecord.url === 'string' && configRecord.url.length > 0,
            envVarCount: envVars,
        };
    }

    return safe;
}

const PRD_FILE_NAME_PATTERN = /^[\w\-. ]+\.(?:txt|md)$/i;

function isPathInside(parentPath, candidatePath): boolean {
    const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
    return Boolean(relativePath)
        && relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);
}

function isPathInsideOrEqual(parentPath, candidatePath): boolean {
    const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
    return relativePath === ''
        || (!relativePath.startsWith(`..${path.sep}`)
            && relativePath !== '..'
            && !path.isAbsolute(relativePath));
}

/**
 * Accepts only one PRD filename directly below `.taskmaster/docs`.
 * Route parameters are untrusted: encoded separators and dot segments must
 * not be allowed to turn a project-scoped read/write into an arbitrary path.
 */
function normalizePrdFileName(value): string | null {
    if (typeof value !== 'string') return null;
    const fileName = value.trim();
    if (!fileName || fileName.includes('/') || fileName.includes('\\')) return null;
    return PRD_FILE_NAME_PATTERN.test(fileName) ? fileName : null;
}

/**
 * Resolves a PRD path under the canonical project docs directory. Existing
 * symlinks are canonicalized before use; a missing target is kept lexical so
 * callers that create a new file can still proceed after their capability
 * guard has admitted the mutation.
 */
async function resolveSafePrdFilePath(fileSystemPromises, projectPath, requestedFileName) {
    const fileName = normalizePrdFileName(requestedFileName);
    if (!fileName) return null;

    const safeDocs = await resolveSafePrdDocsPath(fileSystemPromises, projectPath);
    if (!safeDocs) return null;
    const { canonicalProjectPath, docsPath } = safeDocs;
    const candidatePath = path.resolve(docsPath, fileName);
    if (!isPathInside(docsPath, candidatePath)) return null;

    const realpath = fileSystemPromises.realpath;
    let resolvedPath = candidatePath;
    if (typeof realpath === 'function') {
        try {
            const canonicalCandidatePath = await realpath(candidatePath);
            if (!isPathInside(docsPath, canonicalCandidatePath)
                || !isPathInsideOrEqual(canonicalProjectPath, canonicalCandidatePath)) return null;
            resolvedPath = canonicalCandidatePath;
        } catch (error) {
            const code = error?.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
            // The target may be created by a mutation handler after this
            // check. Keep the canonical docs path for a safe lexical target.
            if (!isPathInside(docsPath, candidatePath)
                || !isPathInsideOrEqual(canonicalProjectPath, candidatePath)) return null;
        }
    }

    return {
        fileName,
        filePath: resolvedPath,
        docsPath,
        canonicalProjectPath,
    };
}

/**
 * Resolves the project and its `.taskmaster/docs` directory before a route
 * lists entries. This keeps the list endpoint from first following a lexical
 * symlink and only validating individual files after the directory has been
 * opened.
 */
async function resolveSafePrdDocsPath(fileSystemPromises, projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return null;

    const realpath = fileSystemPromises.realpath;
    let canonicalProjectPath = path.resolve(projectPath);
    if (typeof realpath === 'function') {
        try {
            canonicalProjectPath = await realpath(canonicalProjectPath);
        } catch (error) {
            const code = error?.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
        }
    }

    const lexicalDocsPath = path.join(canonicalProjectPath, '.taskmaster', 'docs');
    let docsPath = lexicalDocsPath;
    if (typeof realpath === 'function') {
        try {
            docsPath = await realpath(lexicalDocsPath);
        } catch (error) {
            const code = error?.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
        }
    }

    // `.taskmaster/docs` is part of the project boundary too. A symlink at
    // this directory must not turn a project-scoped endpoint into a reader or
    // writer for an unrelated directory elsewhere on disk.
    if (!isPathInsideOrEqual(canonicalProjectPath, docsPath)) return null;
    return { canonicalProjectPath, docsPath };
}

/**
 * Resolves the persisted TaskMaster task file without following a symlink out
 * of the project selected by its database id.  The task route is read-only,
 * but it still must not become an arbitrary host-file reader when a stale or
 * hand-edited `.taskmaster/tasks` entry is present.
 *
 * A missing file returns null so the existing empty-task response is retained;
 * an existing target is returned in canonical form and is the path used by
 * the subsequent read (avoiding a second symlink traversal).
 */
async function resolveSafeTaskFilePath(fileSystemPromises, projectPath) {
    if (typeof projectPath !== 'string' || !projectPath.trim()) return null;

    const realpath = fileSystemPromises.realpath;
    let canonicalProjectPath = path.resolve(projectPath);
    if (typeof realpath === 'function') {
        try {
            canonicalProjectPath = await realpath(canonicalProjectPath);
        } catch (error) {
            const code = error?.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
        }
    }

    const lexicalTaskPath = path.join(
        canonicalProjectPath,
        '.taskmaster',
        'tasks',
        'tasks.json',
    );
    if (typeof realpath !== 'function') {
        return isPathInside(canonicalProjectPath, lexicalTaskPath)
            ? lexicalTaskPath
            : null;
    }

    let canonicalTaskPath;
    try {
        canonicalTaskPath = await realpath(lexicalTaskPath);
    } catch (error) {
        // ENOENT/ENOTDIR are the normal "not initialized" state. Other
        // failures are treated as unavailable rather than exposing a path
        // that could not be canonicalized safely.
        return null;
    }

    if (!isPathInside(canonicalProjectPath, canonicalTaskPath)) {
        return null;
    }

    try {
        // Use the injected filesystem adapter here.  This helper is evaluated
        // before the router factory's local `fsPromises` binding exists, and
        // keeping the adapter explicit also preserves deterministic route
        // tests/alternate hosts.
        const stats = await fileSystemPromises.stat(canonicalTaskPath);
        return stats.isFile() ? canonicalTaskPath : null;
    } catch {
        return null;
    }
}

function sendInvalidPrdFileName(response, _fileName): void {
    response.status(400).json({
        error: 'Invalid filename',
        message: 'Filename must be a single .txt or .md file directly under .taskmaster/docs',
        reasonCode: 'TASKMASTER_INVALID_FILENAME',
    });
}

/**
 * These frames are `type`-keyed and only TaskMasterContext, which lives on the
 * `/ws` chat socket, knows what to do with them. Broadcasting over the raw
 * `wss.clients` set instead delivered them to every `/shell`, `/plugin-ws` and
 * `/desktop-notifications` socket as well, where they were parsed and dropped —
 * and, on `/plugin-ws`, handed to third-party plugin frontends that have no
 * business seeing them. `connectedClients` is the `/ws`-only set every other
 * broadcast in the server already uses.
 */
function broadcastTaskMasterUpdate(type, projectId, payloadKey, payload) {
    if (!projectId) return;
    const message = JSON.stringify({
        type,
        projectId,
        ...(payload === undefined ? {} : { [payloadKey]: payload }),
        timestamp: new Date().toISOString(),
    });
    connectedClients.forEach((client) => {
        if (client.readyState === WS_OPEN_STATE) client.send(message);
    });
}

function broadcastTaskMasterProjectUpdate(projectId, taskMasterData) {
    broadcastTaskMasterUpdate(
        'taskmaster-project-updated',
        projectId,
        'taskMasterData',
        taskMasterData,
    );
}

function broadcastTaskMasterTasksUpdate(projectId, tasksData) {
    broadcastTaskMasterUpdate('taskmaster-tasks-updated', projectId, 'tasksData', tasksData);
}

/**
 * Resolve the absolute project directory from a DB-assigned `projectId`.
 *
 * TaskMaster routes used to accept a Claude-encoded folder name (`projectName`)
 * and derive the path from JSONL history. After the projectId migration the
 * only identifier we accept is the primary key of the `projects` table, so
 * every handler calls this helper and 404s when the id is unknown.
 */
/** Creates Taskmaster routes around explicit filesystem, process, MCP, and project adapters. */
export function createTaskmasterRouter(dependencies: TaskmasterRouterDependencies): express.Router {
    const fs = dependencies.fileSystem;
    const fsPromises = dependencies.fileSystemPromises;
    const spawn = dependencies.spawnProcess;
    const taskmasterCliCommand = dependencies.taskmasterCliCommand?.trim() || 'task-master';
    const taskmasterService = dependencies.taskmasterService;
    const logger = dependencies.logger ?? console;
    // Route factories are also consumed by alternate hosts and tests.  When
    // those callers omit the composition-root guard, retain a startup-fixed
    // policy instead of allowing TaskMaster writes by default.  A local
    // developer process remains writable through the explicit self-hosted
    // default; a configured product/QA or managed SSO profile is denied.
    const fallbackPolicy = captureDeploymentPolicy(dependencies.deploymentPolicy);
    const effectiveCapabilityGuard = (operation: string): RequestHandler => {
        // The production module historically supplied a one-argument factory
        // that created a guard without an explicit policy, causing that guard
        // to re-read process.env for every request.  Pass the captured policy
        // as an optional second argument for newer factories and, regardless
        // of the factory version, inject the trusted request/fallback snapshot
        // before the returned middleware runs.
        const guard = dependencies.capabilityGuard
            ? dependencies.capabilityGuard(operation, fallbackPolicy)
            // Leave the policy option empty here so the guard honors a
            // trusted request.deploymentPolicy when one is present. The
            // wrapper below always injects the startup fallback first, so
            // createDeploymentPolicyGuard never reaches its env parser.
            : createDeploymentPolicyGuard({ capability: operation });
        return (request: PolicyAwareRequest, response, next): void => {
            if (!request.deploymentPolicy) request.deploymentPolicy = fallbackPolicy;
            guard(request, response, next);
        };
    };
    // TaskMaster has two independent read surfaces. Project files/tasks are
    // governed by `project.read`, while MCP/CLI status is governed by
    // `mcp.read`. Keeping these guards inside the router matters for
    // alternate mounts: the application-level mutation guard only protects
    // non-GET requests and cannot express a read capability.
    const taskmasterProjectReadGuard: RequestHandler = effectiveCapabilityGuard(
        DEPLOYMENT_CAPABILITIES.PROJECT_READ,
    );
    const taskmasterMcpReadGuard: RequestHandler = effectiveCapabilityGuard(
        DEPLOYMENT_CAPABILITIES.MCP_READ,
    );

    /**
     * Absolute checkout paths are an implementation detail of the service
     * account. Product/QA users need the project id and relative document
     * names, not `/srv/...` (or a developer's home directory). Preserve the
     * historical field for an explicitly writable local developer profile so
     * older self-hosted clients remain compatible, while omitting it from
     * the managed read-only response contract.
     */
    function taskmasterProjectPathPayload(
        request: PolicyAwareRequest,
        projectPath: string,
    ): Record<string, string> {
        const policy = request.deploymentPolicy ?? fallbackPolicy;
        return (isDeploymentReadOnly(policy) || shouldRedactTaskmasterMcpStatus(request))
            ? {}
            : { projectPath };
    }

    /** Returns a project-relative path for every TaskMaster file response. */
    function taskmasterRelativePath(
        canonicalProjectPath: string,
        filePath: string,
    ): string {
        return path.relative(canonicalProjectPath, filePath);
    }
    const resolveProjectPathFromId = async (projectId) => projectId
        ? dependencies.resolveProjectPathById(projectId)
        : null;
    const router = express.Router();
    // Attach the same fallback policy to requests that arrive through an
    // alternate mount without the application composition middleware.  The
    // production middleware's startup snapshot wins whenever it is already
    // present on the request.
    router.use((request: PolicyAwareRequest, _response, next) => {
        if (!request.deploymentPolicy) request.deploymentPolicy = fallbackPolicy;
        next();
    });
    // TaskMaster writes PRDs and `.taskmaster` state and invokes a CLI process.
    // When a composition root supplies a guard, enforce the boundary inside
    // the router before any handler side effect. The production server also
    // applies its startup-fixed policy at the mount. GET routes remain
    // available to product/QA.
    const taskmasterMutationGuard: RequestHandler = effectiveCapabilityGuard('project.mutate');

    function logTaskmasterFailure(operation: string, details: Record<string, unknown>): void {
        // Never pass an Error object, command, cwd, stdout, or stderr to the
        // logger. Those values may include host paths and inline credentials.
        logger.error('[TaskMaster] operation failed', { operation, ...details });
    }

    function sendTaskmasterFailure(
        response,
        operation: string,
        errorLabel: string,
        reasonCode: string,
        processResult?: TaskmasterProcessResult,
    ): void {
        const payload: Record<string, unknown> = {
            error: errorLabel,
            message: TASKMASTER_PUBLIC_FAILURE_MESSAGE,
            reasonCode,
        };
        if (processResult) payload.code = processResult.code;
        response.status(500).json(payload);
        logTaskmasterFailure(
            operation,
            processResult ? safeProcessMetadata(processResult) : { reasonCode },
        );
    }

    function runTaskmasterProcess(args, options, onComplete) {
        const child = spawn(taskmasterCliCommand, args, options);
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;

        child.stdout.on('data', (data) => {
            stdoutBytes = countTaskmasterOutput(stdoutBytes, data);
        });
        child.stderr.on('data', (data) => {
            stderrBytes = countTaskmasterOutput(stderrBytes, data);
        });

        const settle = (code, error = null) => {
            if (settled) return;
            settled = true;
            onComplete({ code, error, stdoutBytes, stderrBytes });
        };

        child.once('error', (error) => settle(null, error));
        child.once('close', (code) => settle(code));
        return child;
    }

    /**
     * Check if TaskMaster CLI is installed globally
     * @returns {Promise<Object>} Installation status result
     */
    async function checkTaskMasterInstallation() {
        return new Promise((resolve) => {
            // Use the same configured executable as every TaskMaster operation.
            // Invoking `npx task-master` resolves an unrelated npm package, while
            // `task-master-ai` is the package name whose actual CLI bin is
            // `task-master` (its `task-master-ai` bin starts the MCP server).
            const child = spawn(taskmasterCliCommand, ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false
            });

            let outputBytes = 0;
            let errorOutputBytes = 0;
            let output = '';
            let settled = false;

            child.stdout.on('data', (data) => {
                outputBytes = countTaskmasterOutput(outputBytes, data);
                // Version is the only safe portion of this stream to expose;
                // retain a small bounded sample solely for version parsing.
                if (output.length < 256) {
                    output += boundedTaskmasterText(data, 256 - output.length);
                }
            });

            child.stderr.on('data', (data) => {
                errorOutputBytes = countTaskmasterOutput(errorOutputBytes, data);
            });

            child.on('close', (code) => {
                if (settled) return;
                settled = true;
                resolve(code === 0 ? {
                    isInstalled: true,
                    // The executable path is deployment layout information;
                    // callers only need the installation boolean/version.
                    installPath: null,
                    version: parseSafeTaskmasterVersion(output),
                    reason: null,
                    reasonCode: null,
                } : {
                    isInstalled: false,
                    installPath: null,
                    version: null,
                    reason: 'TaskMaster CLI unavailable.',
                    reasonCode: TASKMASTER_CLI_UNAVAILABLE_CODE,
                });
            });

            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                resolve({
                    isInstalled: false,
                    installPath: null,
                    version: null,
                    reason: 'TaskMaster CLI unavailable.',
                    reasonCode: TASKMASTER_CLI_UNAVAILABLE_CODE,
                });
            });
        });
    }

    /**
     * Checking a CLI version is itself an external process execution.  A
     * product/QA deployment may inspect MCP configuration and project files,
     * but must not use this read endpoint as a way to spawn arbitrary
     * TaskMaster binaries.  The startup policy is attached by the composition
     * root; alternate/test routers use the factory's captured fallback policy
     * when no upstream context is present.
     */
    function canInspectTaskMasterInstallation(request: PolicyAwareRequest): boolean {
        const policy = request.deploymentPolicy ?? fallbackPolicy;
        return hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE);
    }

    // API Routes

    /**
     * GET /api/taskmaster/installation-status
     * Check if TaskMaster CLI is installed on the system
     */
    router.get('/installation-status', taskmasterMcpReadGuard, async (req: PolicyAwareRequest, res) => {
        try {
            const installationStatus = canInspectTaskMasterInstallation(req)
                ? await checkTaskMasterInstallation()
                : {
                    isInstalled: false,
                    installPath: null,
                    version: null,
                    reason: 'TaskMaster CLI inspection is disabled by the deployment policy',
                };

            // Also check for MCP server configuration
            const detectedMcpStatus = await taskmasterService.detectMcpServer();
            const mcpStatus = shouldRedactTaskmasterMcpStatus(req)
                ? redactTaskmasterMcpStatus(detectedMcpStatus)
                : detectedMcpStatus;

            res.json({
                success: true,
                installation: installationStatus,
                mcpServer: mcpStatus,
                isReady: installationStatus.isInstalled && mcpStatus.hasMCPServer
            });
        } catch (error) {
            logTaskmasterFailure('installation-status', safeErrorMetadata(error));
            res.status(500).json({
                success: false,
                error: 'Failed to check TaskMaster installation status',
                reasonCode: TASKMASTER_UNEXPECTED_FAILURE_CODE,
                installation: {
                    isInstalled: false,
                    reason: TASKMASTER_PUBLIC_FAILURE_MESSAGE,
                    reasonCode: TASKMASTER_UNEXPECTED_FAILURE_CODE,
                },
                mcpServer: {
                    hasMCPServer: false,
                    reason: TASKMASTER_PUBLIC_FAILURE_MESSAGE,
                    reasonCode: TASKMASTER_UNEXPECTED_FAILURE_CODE,
                },
                isReady: false,
            });
        }
    });

    /**
     * GET /api/taskmaster/mcp-status
     * Check whether TaskMaster is configured in the user's Claude MCP settings.
     */
    router.get('/mcp-status', taskmasterMcpReadGuard, async (req: PolicyAwareRequest, res) => {
        try {
            const detectedStatus = await taskmasterService.detectMcpServer();
            res.json(shouldRedactTaskmasterMcpStatus(req)
                ? redactTaskmasterMcpStatus(detectedStatus)
                : detectedStatus);
        } catch (error) {
            logTaskmasterFailure('mcp-status', safeErrorMetadata(error));
            res.status(500).json({
                error: 'Failed to detect TaskMaster MCP server',
                message: TASKMASTER_PUBLIC_FAILURE_MESSAGE,
                reasonCode: TASKMASTER_UNEXPECTED_FAILURE_CODE,
            });
        }
    });

    /**
     * GET /api/taskmaster/tasks/:projectId
     * Load actual tasks from .taskmaster/tasks/tasks.json
     *
     * `projectId` is the DB primary key of the project; the folder is resolved via
     * the projects table rather than extracted from Claude JSONL history.
     */
    router.get('/tasks/:projectId', taskmasterProjectReadGuard, async (req, res) => {
        try {
            const { projectId } = req.params;

            // Get project path via the DB; the legacy JSONL-based resolver is gone.
            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            const tasksFilePath = await resolveSafeTaskFilePath(fsPromises, projectPath);

            // Check if tasks file exists
            if (!tasksFilePath) {
                return res.json({
                    projectId,
                    tasks: [],
                    message: 'No tasks.json file found'
                });
            }

            // Read and parse tasks file
            try {
                const tasksContent = await fsPromises.readFile(tasksFilePath, 'utf8');
                const tasksData = JSON.parse(tasksContent);

                let tasks = [];
                let currentTag = 'master';

                // Handle both tagged and legacy formats
                if (Array.isArray(tasksData)) {
                    // Legacy format
                    tasks = tasksData;
                } else if (tasksData.tasks) {
                    // Simple format with tasks array
                    tasks = tasksData.tasks;
                } else {
                    // Tagged format - get tasks from current tag or master
                    if (tasksData[currentTag] && tasksData[currentTag].tasks) {
                        tasks = tasksData[currentTag].tasks;
                    } else if (tasksData.master && tasksData.master.tasks) {
                        tasks = tasksData.master.tasks;
                    } else {
                        // Get tasks from first available tag
                        const firstTag = Object.keys(tasksData).find(key =>
                            tasksData[key].tasks && Array.isArray(tasksData[key].tasks)
                        );
                        if (firstTag) {
                            tasks = tasksData[firstTag].tasks;
                            currentTag = firstTag;
                        }
                    }
                }

                // Transform tasks to ensure all have required fields
                const transformedTasks = tasks.map(task => ({
                    id: task.id,
                    title: task.title || 'Untitled Task',
                    description: task.description || '',
                    status: task.status || 'pending',
                    priority: task.priority || 'medium',
                    dependencies: task.dependencies || [],
                    createdAt: task.createdAt || task.created || new Date().toISOString(),
                    updatedAt: task.updatedAt || task.updated || new Date().toISOString(),
                    details: task.details || '',
                    testStrategy: task.testStrategy || task.test_strategy || '',
                    subtasks: task.subtasks || []
                }));

                res.json({
                    projectId,
                    ...taskmasterProjectPathPayload(req, projectPath),
                    tasks: transformedTasks,
                    currentTag,
                    totalTasks: transformedTasks.length,
                    tasksByStatus: {
                        pending: transformedTasks.filter(t => t.status === 'pending').length,
                        'in-progress': transformedTasks.filter(t => t.status === 'in-progress').length,
                        done: transformedTasks.filter(t => t.status === 'done').length,
                        review: transformedTasks.filter(t => t.status === 'review').length,
                        deferred: transformedTasks.filter(t => t.status === 'deferred').length,
                        cancelled: transformedTasks.filter(t => t.status === 'cancelled').length
                    },
                    timestamp: new Date().toISOString()
                });

            } catch (parseError) {
                sendTaskmasterFailure(
                    res,
                    'tasks.parse',
                    'Failed to parse tasks file',
                    TASKMASTER_UNEXPECTED_FAILURE_CODE,
                );
                return;
            }

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'tasks.load',
                'Failed to load TaskMaster tasks',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * GET /api/taskmaster/prd/:projectId
     * List all PRD files in the project's .taskmaster/docs directory
     */
    router.get('/prd/:projectId', taskmasterProjectReadGuard, async (req, res) => {
        try {
            const { projectId } = req.params;

            // projectId → projectPath lookup through the DB (post-migration).
            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            const safeDocsPath = await resolveSafePrdDocsPath(fsPromises, projectPath);
            if (!safeDocsPath) {
                return res.status(403).json({
                    error: 'PRD path is outside the project root',
                    code: 'PATH_OUTSIDE_PROJECT',
                });
            }
            const { docsPath } = safeDocsPath;

            // Check if docs directory exists
            try {
                await fsPromises.access(docsPath, fs.constants.R_OK);
            } catch (error) {
                return res.json({
                    projectId,
                    prdFiles: [],
                    message: 'No .taskmaster/docs directory found'
                });
            }

            // Read directory and filter for PRD files
            try {
                const files = await fsPromises.readdir(docsPath);
                const prdFiles = [];

                for (const file of files) {
                    // Directory entries are filesystem data, but a malicious
                    // or stale symlink can still point outside the project.
                    // Reuse the same canonical PRD resolver used by the
                    // content endpoint before following any entry.
                    const safePrdPath = await resolveSafePrdFilePath(
                        fsPromises,
                        projectPath,
                        file,
                    );
                    if (!safePrdPath) continue;
                    const filePath = safePrdPath.filePath;
                    const stats = await fsPromises.stat(filePath);

                    if (stats.isFile() && (file.endsWith('.txt') || file.endsWith('.md'))) {
                        prdFiles.push({
                            name: file,
                            path: taskmasterRelativePath(safePrdPath.canonicalProjectPath, filePath),
                            size: stats.size,
                            modified: stats.mtime.toISOString(),
                            created: stats.birthtime.toISOString()
                        });
                    }
                }

                res.json({
                    projectId,
                    ...taskmasterProjectPathPayload(req, projectPath),
                    prdFiles: prdFiles.sort((a, b) => new Date(b.modified) - new Date(a.modified)),
                    timestamp: new Date().toISOString()
                });

            } catch (readError) {
                sendTaskmasterFailure(
                    res,
                    'prd.list',
                    'Failed to read PRD files',
                    TASKMASTER_UNEXPECTED_FAILURE_CODE,
                );
                return;
            }

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'prd.list',
                'Failed to list PRD files',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * POST /api/taskmaster/prd/:projectId
     * Create or update a PRD file in the project's .taskmaster/docs directory
     */
    router.post('/prd/:projectId', taskmasterMutationGuard, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { fileName, content } = req.body;

            if (!fileName || !content) {
                return res.status(400).json({
                    error: 'Missing required fields',
                    message: 'fileName and content are required'
                });
            }

            // Validate the filename before resolving any project path. This
            // endpoint writes into `.taskmaster/docs`, so separators must not
            // be accepted even when they arrive percent-encoded in a client
            // request body.
            const safePrdPathInput = normalizePrdFileName(fileName);
            if (!safePrdPathInput) {
                return sendInvalidPrdFileName(res, fileName);
            }

            // Resolve the project folder through the DB using the projectId param.
            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            const safePrdPath = await resolveSafePrdFilePath(
                fsPromises,
                projectPath,
                safePrdPathInput,
            );
            if (!safePrdPath) {
                return sendInvalidPrdFileName(res, fileName);
            }
            const { docsPath, filePath, canonicalProjectPath } = safePrdPath;

            // Ensure docs directory exists
            try {
                await fsPromises.mkdir(docsPath, { recursive: true });
            } catch (error) {
                sendTaskmasterFailure(
                    res,
                    'prd.create-directory',
                    'Failed to create directory',
                    TASKMASTER_UNEXPECTED_FAILURE_CODE,
                );
                return;
            }

            // Write the PRD file
            try {
                await fsPromises.writeFile(filePath, content, 'utf8');

                // Get file stats
                const stats = await fsPromises.stat(filePath);

                res.json({
                    projectId,
                    // Keep the response contract consistent with every other
                    // TaskMaster route: managed/read-only callers receive the
                    // project id and relative filename only, while an
                    // explicitly writable local developer keeps the legacy
                    // absolute projectPath field.
                    ...taskmasterProjectPathPayload(req, projectPath),
                    fileName: safePrdPath.fileName,
                    filePath: path.relative(canonicalProjectPath, filePath),
                    size: stats.size,
                    created: stats.birthtime.toISOString(),
                    modified: stats.mtime.toISOString(),
                    message: 'PRD file saved successfully',
                    timestamp: new Date().toISOString()
                });

            } catch (writeError) {
                sendTaskmasterFailure(
                    res,
                    'prd.write',
                    'Failed to write PRD file',
                    TASKMASTER_UNEXPECTED_FAILURE_CODE,
                );
                return;
            }

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'prd.create',
                'Failed to create/update PRD file',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * GET /api/taskmaster/prd/:projectId/:fileName
     * Get content of a specific PRD file
     */
    router.get('/prd/:projectId/:fileName', taskmasterProjectReadGuard, async (req, res) => {
        try {
            const { projectId, fileName } = req.params;

            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            const safePrdPath = await resolveSafePrdFilePath(
                fsPromises,
                projectPath,
                fileName,
            );
            if (!safePrdPath) {
                return sendInvalidPrdFileName(res, fileName);
            }
            const { filePath, canonicalProjectPath } = safePrdPath;

            // Check if file exists
            try {
                await fsPromises.access(filePath, fs.constants.R_OK);
            } catch (error) {
                return res.status(404).json({
                    error: 'PRD file not found',
                    message: 'PRD file not found'
                });
            }

            // Read file content
            try {
                const content = await fsPromises.readFile(filePath, 'utf8');
                const stats = await fsPromises.stat(filePath);

                res.json({
                    projectId,
                    ...taskmasterProjectPathPayload(req, projectPath),
                    fileName: safePrdPath.fileName,
                    filePath: taskmasterRelativePath(canonicalProjectPath, filePath),
                    content,
                    size: stats.size,
                    created: stats.birthtime.toISOString(),
                    modified: stats.mtime.toISOString(),
                    timestamp: new Date().toISOString()
                });

            } catch (readError) {
                sendTaskmasterFailure(
                    res,
                    'prd.read',
                    'Failed to read PRD file',
                    TASKMASTER_UNEXPECTED_FAILURE_CODE,
                );
                return;
            }

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'prd.read',
                'Failed to read PRD file',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * POST /api/taskmaster/init/:projectId
     * Initialize TaskMaster in a project
     */
    router.post('/init/:projectId', taskmasterMutationGuard, async (req, res) => {
        try {
            const { projectId } = req.params;

            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            // Check if TaskMaster is already initialized
            const taskMasterPath = path.join(projectPath, '.taskmaster');
            try {
                await fsPromises.access(taskMasterPath, fs.constants.F_OK);
                return res.status(400).json({
                    error: 'TaskMaster already initialized',
                    message: 'TaskMaster is already configured for this project'
                });
            } catch (error) {
                // Directory doesn't exist, we can proceed
            }

            // Run taskmaster init command
            const initProcess = runTaskmasterProcess(['init', '-y'], {
                cwd: projectPath,
                stdio: ['pipe', 'pipe', 'pipe']
            }, (result: TaskmasterProcessResult) => {
                const { code } = result;
                if (code === 0) {
                    // Broadcast TaskMaster project update via WebSocket. The
                    // WebSocket payload keeps using `projectId` so the frontend
                    // can match notifications against the current selection.
                    broadcastTaskMasterProjectUpdate(projectId, { hasTaskmaster: true, status: 'initialized' });

                    res.json({
                        projectId,
                        ...taskmasterProjectPathPayload(req, projectPath),
                        message: 'TaskMaster initialized successfully',
                        output: null,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    sendTaskmasterFailure(
                        res,
                        'init',
                        'Failed to initialize TaskMaster',
                        TASKMASTER_PROCESS_FAILURE_CODE,
                        result,
                    );
                }
            });

            // `-y` makes initialization non-interactive for the API route.
            initProcess.stdin.end();

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'init',
                'Failed to initialize TaskMaster',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * POST /api/taskmaster/add-task/:projectId
     * Add a new task to the project
     */
    router.post('/add-task/:projectId', taskmasterMutationGuard, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { prompt, title, description, priority = 'medium', dependencies } = req.body;

            if (!prompt && (!title || !description)) {
                return res.status(400).json({
                    error: 'Missing required parameters',
                    message: 'Either "prompt" or both "title" and "description" are required'
                });
            }

            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            // Build the task-master add-task command
            const args = ['add-task'];

            if (prompt) {
                args.push('--prompt', prompt);
                args.push('--research'); // Use research for AI-generated tasks
            } else {
                args.push('--prompt', `Create a task titled "${title}" with description: ${description}`);
            }

            if (priority) {
                args.push('--priority', priority);
            }

            if (dependencies) {
                args.push('--dependencies', dependencies);
            }

            // Run task-master add-task command
            const addTaskProcess = runTaskmasterProcess(args, {
                cwd: projectPath,
                stdio: ['pipe', 'pipe', 'pipe']
            }, (result: TaskmasterProcessResult) => {
                const { code } = result;

                if (code === 0) {
                    // Broadcast task update via WebSocket using the projectId so
                    // clients subscribed to this project get notified immediately.
                    broadcastTaskMasterTasksUpdate(projectId);

                    res.json({
                        projectId,
                        ...taskmasterProjectPathPayload(req, projectPath),
                        message: 'Task added successfully',
                        output: null,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    sendTaskmasterFailure(
                        res,
                        'add-task',
                        'Failed to add task',
                        TASKMASTER_PROCESS_FAILURE_CODE,
                        result,
                    );
                }
            });

            addTaskProcess.stdin.end();

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'add-task',
                'Failed to add task',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * PUT /api/taskmaster/update-task/:projectId/:taskId
     * Update a specific task using TaskMaster CLI
     */
    router.put('/update-task/:projectId/:taskId', taskmasterMutationGuard, async (req, res) => {
        try {
            const { projectId, taskId } = req.params;
            const { title, description, status, priority, details } = req.body;

            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            // If only updating status, use set-status command
            if (status && Object.keys(req.body).length === 1) {
                const setStatusProcess = runTaskmasterProcess(['set-status', `--id=${taskId}`, `--status=${status}`], {
                    cwd: projectPath,
                    stdio: ['pipe', 'pipe', 'pipe']
                }, (result: TaskmasterProcessResult) => {
                    const { code } = result;
                    if (code === 0) {
                        // Broadcast task update via WebSocket
                        broadcastTaskMasterTasksUpdate(projectId);

                        res.json({
                            projectId,
                            ...taskmasterProjectPathPayload(req, projectPath),
                            taskId,
                            message: 'Task status updated successfully',
                            output: null,
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        sendTaskmasterFailure(
                            res,
                            'update-task.status',
                            'Failed to update task status',
                            TASKMASTER_PROCESS_FAILURE_CODE,
                            result,
                        );
                    }
                });

                setStatusProcess.stdin.end();
            } else {
                // For other updates, use update-task command with a prompt describing the changes
                const updates = [];
                if (title) updates.push(`title: "${title}"`);
                if (description) updates.push(`description: "${description}"`);
                if (priority) updates.push(`priority: "${priority}"`);
                if (details) updates.push(`details: "${details}"`);

                const prompt = `Update task with the following changes: ${updates.join(', ')}`;

                const updateProcess = runTaskmasterProcess(['update-task', `--id=${taskId}`, `--prompt=${prompt}`], {
                    cwd: projectPath,
                    stdio: ['pipe', 'pipe', 'pipe']
                }, (result: TaskmasterProcessResult) => {
                    const { code } = result;
                    if (code === 0) {
                        // Broadcast task update via WebSocket
                        broadcastTaskMasterTasksUpdate(projectId);

                        res.json({
                            projectId,
                            ...taskmasterProjectPathPayload(req, projectPath),
                            taskId,
                            message: 'Task updated successfully',
                            output: null,
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        sendTaskmasterFailure(
                            res,
                            'update-task',
                            'Failed to update task',
                            TASKMASTER_PROCESS_FAILURE_CODE,
                            result,
                        );
                    }
                });

                updateProcess.stdin.end();
            }

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'update-task',
                'Failed to update task',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * POST /api/taskmaster/parse-prd/:projectId
     * Parse a PRD file to generate tasks
     */
    router.post('/parse-prd/:projectId', taskmasterMutationGuard, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { fileName = 'prd.txt', numTasks, append = false } = req.body;

            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            const safePrdPath = await resolveSafePrdFilePath(
                fsPromises,
                projectPath,
                fileName,
            );
            if (!safePrdPath) {
                return sendInvalidPrdFileName(res, fileName);
            }
            const prdPath = safePrdPath.filePath;

            // Check if PRD file exists
            try {
                await fsPromises.access(prdPath, fs.constants.F_OK);
            } catch (error) {
                return res.status(404).json({
                    error: 'PRD file not found',
                    message: 'PRD file not found'
                });
            }

            // Build the command args
            const args = ['parse-prd', '--input', prdPath];

            if (numTasks) {
                args.push('--num-tasks', numTasks.toString());
            }

            if (append) {
                args.push('--append');
            }

            args.push('--research'); // Use research for better PRD parsing

            // Run task-master parse-prd command
            const parsePRDProcess = runTaskmasterProcess(args, {
                cwd: safePrdPath.canonicalProjectPath,
                stdio: ['pipe', 'pipe', 'pipe']
            }, (result: TaskmasterProcessResult) => {
                const { code } = result;
                if (code === 0) {
                    // Broadcast task update via WebSocket
                    broadcastTaskMasterTasksUpdate(projectId);

                    res.json({
                        projectId,
                        ...taskmasterProjectPathPayload(req, projectPath),
                        prdFile: safePrdPath.fileName,
                        message: 'PRD parsed and tasks generated successfully',
                        output: null,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    sendTaskmasterFailure(
                        res,
                        'parse-prd',
                        'Failed to parse PRD',
                        TASKMASTER_PROCESS_FAILURE_CODE,
                        result,
                    );
                }
            });

            parsePRDProcess.stdin.end();

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'parse-prd',
                'Failed to parse PRD',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * GET /api/taskmaster/prd-templates
     * Get available PRD templates
     */
    // Templates are a read-only TaskMaster surface. Keep the capability guard
    // inside the feature router so alternate mounts cannot expose the route
    // when project discovery is disabled, even if the UI hides the entry.
    router.get('/prd-templates', taskmasterProjectReadGuard, async (req, res) => {
        try {
            // Return built-in templates
            const templates = [
                {
                    id: 'web-app',
                    name: 'Web Application',
                    description: 'Template for web application projects with frontend and backend components',
                    category: 'web',
                    content: `# Product Requirements Document - Web Application

## Overview
**Product Name:** [Your App Name]
**Version:** 1.0
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Brief description of what this web application will do and why it's needed.

## Product Goals
- Goal 1: [Specific measurable goal]
- Goal 2: [Specific measurable goal]
- Goal 3: [Specific measurable goal]

## User Stories
### Core Features
1. **User Registration & Authentication**
   - As a user, I want to create an account so I can access personalized features
   - As a user, I want to log in securely so my data is protected
   - As a user, I want to reset my password if I forget it

2. **Main Application Features**
   - As a user, I want to [core feature 1] so I can [benefit]
   - As a user, I want to [core feature 2] so I can [benefit]
   - As a user, I want to [core feature 3] so I can [benefit]

3. **User Interface**
   - As a user, I want a responsive design so I can use the app on any device
   - As a user, I want intuitive navigation so I can easily find features

## Technical Requirements
### Frontend
- Framework: React/Vue/Angular or vanilla JavaScript
- Styling: CSS framework (Tailwind, Bootstrap, etc.)
- State Management: Redux/Vuex/Context API
- Build Tools: Webpack/Vite
- Testing: Jest/Vitest for unit tests

### Backend
- Runtime: Node.js/Python/Java
- Database: PostgreSQL/MySQL/MongoDB
- API: RESTful API or GraphQL
- Authentication: JWT tokens
- Testing: Integration and unit tests

### Infrastructure
- Hosting: Cloud provider (AWS, Azure, GCP)
- CI/CD: GitHub Actions/GitLab CI
- Monitoring: Application monitoring tools
- Security: HTTPS, input validation, rate limiting

## Success Metrics
- User engagement metrics
- Performance benchmarks (load time < 2s)
- Error rates < 1%
- User satisfaction scores

## Timeline
- Phase 1: Core functionality (4-6 weeks)
- Phase 2: Advanced features (2-4 weeks)
- Phase 3: Polish and launch (2 weeks)

## Constraints & Assumptions
- Budget constraints
- Technical limitations
- Team size and expertise
- Timeline constraints`
                },
                {
                    id: 'api',
                    name: 'REST API',
                    description: 'Template for REST API development projects',
                    category: 'backend',
                    content: `# Product Requirements Document - REST API

## Overview
**API Name:** [Your API Name]
**Version:** v1.0
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Description of the API's purpose, target users, and primary use cases.

## API Goals
- Goal 1: Provide secure data access
- Goal 2: Ensure scalable architecture
- Goal 3: Maintain high availability (99.9% uptime)

## Functional Requirements
### Core Endpoints
1. **Authentication Endpoints**
   - POST /api/auth/login - User authentication
   - POST /api/auth/logout - User logout
   - POST /api/auth/refresh - Token refresh
   - POST /api/auth/register - User registration

2. **Data Management Endpoints**
   - GET /api/resources - List resources with pagination
   - GET /api/resources/{id} - Get specific resource
   - POST /api/resources - Create new resource
   - PUT /api/resources/{id} - Update existing resource
   - DELETE /api/resources/{id} - Delete resource

3. **Administrative Endpoints**
   - GET /api/admin/users - Manage users (admin only)
   - GET /api/admin/analytics - System analytics
   - POST /api/admin/backup - Trigger system backup

## Technical Requirements
### API Design
- RESTful architecture following OpenAPI 3.0 specification
- JSON request/response format
- Consistent error response format
- API versioning strategy

### Authentication & Security
- JWT token-based authentication
- Role-based access control (RBAC)
- Rate limiting (100 requests/minute per user)
- Input validation and sanitization
- HTTPS enforcement

### Database
- Database type: [PostgreSQL/MongoDB/MySQL]
- Connection pooling
- Database migrations
- Backup and recovery procedures

### Performance Requirements
- Response time: < 200ms for 95% of requests
- Throughput: 1000+ requests/second
- Concurrent users: 10,000+
- Database query optimization

### Documentation
- Auto-generated API documentation (Swagger/OpenAPI)
- Code examples for common use cases
- SDK development for major languages
- Postman collection for testing

## Error Handling
- Standardized error codes and messages
- Proper HTTP status codes
- Detailed error logging
- Graceful degradation strategies

## Testing Strategy
- Unit tests (80%+ coverage)
- Integration tests for all endpoints
- Load testing and performance testing
- Security testing (OWASP compliance)

## Monitoring & Logging
- Application performance monitoring
- Error tracking and alerting
- Access logs and audit trails
- Health check endpoints

## Deployment
- Containerized deployment (Docker)
- CI/CD pipeline setup
- Environment management (dev, staging, prod)
- Blue-green deployment strategy

## Success Metrics
- API uptime > 99.9%
- Average response time < 200ms
- Zero critical security vulnerabilities
- Developer adoption metrics`
                },
                {
                    id: 'mobile-app',
                    name: 'Mobile Application',
                    description: 'Template for mobile app development projects (iOS/Android)',
                    category: 'mobile',
                    content: `# Product Requirements Document - Mobile Application

## Overview
**App Name:** [Your App Name]
**Platform:** iOS / Android / Cross-platform
**Version:** 1.0
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Brief description of the mobile app's purpose, target audience, and key value proposition.

## Product Goals
- Goal 1: [Specific user engagement goal]
- Goal 2: [Specific functionality goal]
- Goal 3: [Specific performance goal]

## User Stories
### Core Features
1. **Onboarding & Authentication**
   - As a new user, I want a simple onboarding process
   - As a user, I want to sign up with email or social media
   - As a user, I want biometric authentication for security

2. **Main App Features**
   - As a user, I want [core feature 1] accessible from home screen
   - As a user, I want [core feature 2] to work offline
   - As a user, I want to sync data across devices

3. **User Experience**
   - As a user, I want intuitive navigation patterns
   - As a user, I want fast loading times
   - As a user, I want accessibility features

## Technical Requirements
### Mobile Development
- **Cross-platform:** React Native / Flutter / Xamarin
- **Native:** Swift (iOS) / Kotlin (Android)
- **State Management:** Redux / MobX / Provider
- **Navigation:** React Navigation / Flutter Navigation

### Backend Integration
- REST API or GraphQL integration
- Real-time features (WebSockets/Push notifications)
- Offline data synchronization
- Background processing

### Device Features
- Camera and photo library access
- GPS location services
- Push notifications
- Biometric authentication
- Device storage

### Performance Requirements
- App launch time < 3 seconds
- Screen transition animations < 300ms
- Memory usage optimization
- Battery usage optimization

## Platform-Specific Considerations
### iOS Requirements
- iOS 13.0+ minimum version
- App Store guidelines compliance
- iOS design guidelines (Human Interface Guidelines)
- TestFlight beta testing

### Android Requirements
- Android 8.0+ (API level 26) minimum
- Google Play Store guidelines
- Material Design guidelines
- Google Play Console testing

## User Interface Design
- Responsive design for different screen sizes
- Dark mode support
- Accessibility compliance (WCAG 2.1)
- Consistent design system

## Security & Privacy
- Secure data storage (Keychain/Keystore)
- API communication encryption
- Privacy policy compliance (GDPR/CCPA)
- App security best practices

## Testing Strategy
- Unit testing (80%+ coverage)
- UI/E2E testing (Detox/Appium)
- Device testing on multiple screen sizes
- Performance testing
- Security testing

## App Store Deployment
- App store optimization (ASO)
- App icons and screenshots
- Store listing content
- Release management strategy

## Analytics & Monitoring
- User analytics (Firebase/Analytics)
- Crash reporting (Crashlytics/Sentry)
- Performance monitoring
- User feedback collection

## Success Metrics
- App store ratings > 4.0
- User retention rates
- Daily/Monthly active users
- App performance metrics
- Conversion rates`
                },
                {
                    id: 'data-analysis',
                    name: 'Data Analysis Project',
                    description: 'Template for data analysis and visualization projects',
                    category: 'data',
                    content: `# Product Requirements Document - Data Analysis Project

## Overview
**Project Name:** [Your Analysis Project]
**Analysis Type:** [Descriptive/Predictive/Prescriptive]
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Description of the business problem, data sources, and expected insights.

## Project Goals
- Goal 1: [Specific business question to answer]
- Goal 2: [Specific prediction to make]
- Goal 3: [Specific recommendation to provide]

## Business Requirements
### Key Questions
1. What patterns exist in the current data?
2. What factors influence [target variable]?
3. What predictions can be made for [future outcome]?
4. What recommendations can improve [business metric]?

### Success Criteria
- Actionable insights for stakeholders
- Statistical significance in findings
- Reproducible analysis pipeline
- Clear visualization and reporting

## Data Requirements
### Data Sources
1. **Primary Data**
   - Source: [Database/API/Files]
   - Format: [CSV/JSON/SQL]
   - Size: [Volume estimate]
   - Update frequency: [Real-time/Daily/Monthly]

2. **External Data**
   - Third-party APIs
   - Public datasets
   - Market research data

### Data Quality Requirements
- Data completeness (< 5% missing values)
- Data accuracy validation
- Data consistency checks
- Historical data availability

## Technical Requirements
### Data Pipeline
- Data extraction and ingestion
- Data cleaning and preprocessing
- Data transformation and feature engineering
- Data validation and quality checks

### Analysis Tools
- **Programming:** Python/R/SQL
- **Libraries:** pandas, numpy, scikit-learn, matplotlib
- **Visualization:** Tableau, PowerBI, or custom dashboards
- **Version Control:** Git for code and DVC for data

### Computing Resources
- Local development environment
- Cloud computing (AWS/GCP/Azure) if needed
- Database access and permissions
- Storage requirements

## Analysis Methodology
### Data Exploration
1. Descriptive statistics and data profiling
2. Data visualization and pattern identification
3. Correlation analysis
4. Outlier detection and handling

### Statistical Analysis
1. Hypothesis formulation
2. Statistical testing
3. Confidence intervals
4. Effect size calculations

### Machine Learning (if applicable)
1. Feature selection and engineering
2. Model selection and training
3. Cross-validation and evaluation
4. Model interpretation and explainability

## Deliverables
### Reports
- Executive summary for stakeholders
- Technical analysis report
- Data quality report
- Methodology documentation

### Visualizations
- Interactive dashboards
- Static charts and graphs
- Data story presentations
- Key findings infographics

### Code & Documentation
- Reproducible analysis scripts
- Data pipeline code
- Documentation and comments
- Testing and validation code

## Timeline
- Phase 1: Data collection and exploration (2 weeks)
- Phase 2: Analysis and modeling (3 weeks)
- Phase 3: Reporting and visualization (1 week)
- Phase 4: Stakeholder presentation (1 week)

## Risks & Assumptions
- Data availability and quality risks
- Technical complexity assumptions
- Resource and timeline constraints
- Stakeholder engagement assumptions

## Success Metrics
- Stakeholder satisfaction with insights
- Accuracy of predictions (if applicable)
- Business impact of recommendations
- Reproducibility of results`
                }
            ];

            res.json({
                templates,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'prd-templates',
                'Failed to get PRD templates',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    /**
     * POST /api/taskmaster/apply-template/:projectId
     * Apply a PRD template to create a new PRD file
     */
    router.post('/apply-template/:projectId', taskmasterMutationGuard, async (req, res) => {
        try {
            const { projectId } = req.params;
            const { templateId, fileName = 'prd.txt', customizations = {} } = req.body;

            if (!templateId) {
                return res.status(400).json({
                    error: 'Missing required parameter',
                    message: 'templateId is required'
                });
            }

            const projectPath = await resolveProjectPathFromId(projectId);
            if (!projectPath) {
                return res.status(404).json({
                    error: 'Project not found',
                    message: 'Project not found'
                });
            }

            const safePrdPath = await resolveSafePrdFilePath(
                fsPromises,
                projectPath,
                fileName,
            );
            if (!safePrdPath) {
                return sendInvalidPrdFileName(res, fileName);
            }

            // Get the template content (this would normally fetch from the templates list)
            const templates = await getAvailableTemplates();
            const template = templates.find(t => t.id === templateId);

            if (!template) {
                return res.status(404).json({
                    error: 'Template not found',
                    message: 'Template not found'
                });
            }

            // Apply customizations to template content
            let content = template.content;

            // Replace placeholders with customizations
            for (const [key, value] of Object.entries(customizations)) {
                const placeholder = `[${key}]`;
                content = content.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'g'), value);
            }

            // Ensure .taskmaster/docs directory exists
            try {
                await fsPromises.mkdir(safePrdPath.docsPath, { recursive: true });
            } catch (error) {
                sendTaskmasterFailure(
                    res,
                    'apply-template.create-directory',
                    'Failed to create directory',
                    TASKMASTER_UNEXPECTED_FAILURE_CODE,
                );
                return;
            }

            // Write the template content to the file
            try {
                await fsPromises.writeFile(safePrdPath.filePath, content, 'utf8');

                res.json({
                    projectId,
                    ...taskmasterProjectPathPayload(req, projectPath),
                    templateId,
                    templateName: template.name,
                    fileName: safePrdPath.fileName,
                    filePath: taskmasterRelativePath(
                        safePrdPath.canonicalProjectPath,
                        safePrdPath.filePath,
                    ),
                    message: 'PRD template applied successfully',
                    output: null,
                    timestamp: new Date().toISOString()
                });

            } catch (writeError) {
                sendTaskmasterFailure(
                    res,
                    'apply-template.write',
                    'Failed to write PRD template',
                    TASKMASTER_UNEXPECTED_FAILURE_CODE,
                );
                return;
            }

        } catch (error) {
            sendTaskmasterFailure(
                res,
                'apply-template',
                'Failed to apply PRD template',
                TASKMASTER_UNEXPECTED_FAILURE_CODE,
            );
        }
    });

    // Helper function to get available templates
    async function getAvailableTemplates() {
        // This could be extended to read from files or database
        return [
            {
                id: 'web-app',
                name: 'Web Application',
                description: 'Template for web application projects',
                category: 'web',
                content: `# Product Requirements Document - Web Application

## Overview
**Product Name:** [Your App Name]
**Version:** 1.0
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Brief description of what this web application will do and why it's needed.

## User Stories
1. As a user, I want [feature] so I can [benefit]
2. As a user, I want [feature] so I can [benefit]
3. As a user, I want [feature] so I can [benefit]

## Technical Requirements
- Frontend framework
- Backend services
- Database requirements
- Security considerations

## Success Metrics
- User engagement metrics
- Performance benchmarks
- Business objectives`
            },
            // Add other templates here if needed
        ];
    }

    return router;
}
