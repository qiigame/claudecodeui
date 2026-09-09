// @ts-nocheck -- temporary while command handlers are extracted into the injected service.
import path from 'node:path';

import express from "express";

import {
  captureDeploymentPolicy,
  hasDeploymentCapability,
  isDeploymentReadOnly,
} from '@/modules/deployment-policy/index.js';
import { AppError } from '@/shared/utils.js';
import { parseFrontMatter } from '@/shared/frontmatter.js';

type CommandsRouterDependencies = {
  fileSystem: typeof import('node:fs/promises');
  homeDirectory(): string;
  appRoot: string;
  models: typeof import('../providers/index.js').providerModelsService;
  runtime: {
    uptime(): number;
    memoryUsage(): NodeJS.MemoryUsage;
    version: string;
    platform: NodeJS.Platform;
    pid: number;
  };
  /** Optional deployment policy override for composition roots and tests. */
  deploymentPolicy?: import('@/modules/deployment-policy/index.js').DeploymentPolicy
    | (() => import('@/modules/deployment-policy/index.js').DeploymentPolicy);
  /** Resolve a client-supplied project id through the server-owned project registry. */
  resolveProjectPathById?: (projectId: string) => string | null | Promise<string | null>;
  /** Resolve a legacy path only when it is already registered by the server. */
  resolveRegisteredProjectPath?: (projectPath: string) => string | null | Promise<string | null>;
};

/** Creates Commands routes around explicit filesystem, model-catalog, and runtime adapters. */
export function createCommandsRouter(dependencies: CommandsRouterDependencies): express.Router {
const fs = dependencies.fileSystem;
const os = { homedir: dependencies.homeDirectory };
const APP_ROOT = dependencies.appRoot;
const providerModelsService = dependencies.models;
const process = dependencies.runtime;
const router = express.Router();
// Capture the explicit source (or the ambient environment) once while this
// router is assembled.  A trusted composition middleware may attach a more
// specific request snapshot later; absent that context, requests always use
// this immutable startup fallback rather than reparsing process.env.
const startupDeploymentPolicy = captureDeploymentPolicy(dependencies.deploymentPolicy);

const resolveDeploymentPolicy = (request) => {
  return request?.deploymentPolicy || startupDeploymentPolicy;
};

/**
 * Reads a project identifier from a command context/request without trusting
 * the path field as an authority.  New clients send `projectId`; the path is
 * retained only as a backwards-compatible lookup hint for older clients.
 */
const readProjectId = (source) => {
  const value = source?.projectId;
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
};

const readProjectPath = (source) => {
  const value = source?.projectPath;
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Resolves the project directory through the server-owned registry.  A
 * deployment that supplies either resolver rejects unregistered legacy paths;
 * standalone callers without a registry retain the historical path behavior
 * for compatibility with local tests and developer-only integrations.
 */
const resolveAuthorizedProjectPath = async (source) => {
  const projectId = readProjectId(source);
  const requestedPath = readProjectPath(source);

  if (projectId) {
    if (!dependencies.resolveProjectPathById) {
      throw new AppError('Project id resolution is unavailable.', {
        code: 'PROJECT_RESOLUTION_UNAVAILABLE',
        statusCode: 503,
      });
    }
    const resolved = await dependencies.resolveProjectPathById(projectId);
    if (!resolved || typeof resolved !== 'string' || !resolved.trim()) {
      throw new AppError(`Project "${projectId}" was not found.`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }
    // The id is authoritative. Never let a conflicting client path redirect
    // the subsequent command lookup to a different project.
    return canonicalizeExistingPath(path.resolve(resolved));
  }

  if (!requestedPath) {
    return null;
  }

  if (dependencies.resolveRegisteredProjectPath) {
    const registered = await dependencies.resolveRegisteredProjectPath(requestedPath);
    if (!registered || typeof registered !== 'string' || !registered.trim()) {
      throw new AppError('Project path is not registered for this deployment.', {
        code: 'PROJECT_PATH_NOT_REGISTERED',
        statusCode: 403,
      });
    }
    return canonicalizeExistingPath(path.resolve(registered));
  }

  return canonicalizeExistingPath(path.resolve(requestedPath));
};

/** Returns an absolute path after resolving symlinks when the injected fs supports realpath. */
const canonicalizeExistingPath = async (candidatePath) => {
  const absolutePath = path.resolve(candidatePath);
  if (typeof fs.realpath !== 'function') {
    return absolutePath;
  }

  try {
    return await fs.realpath(absolutePath);
  } catch (error) {
    // Let the normal read/access operation produce its 404/empty result for a
    // path that does not exist yet. Existing paths are always canonicalized so
    // symlinks cannot escape the authorized command roots.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return absolutePath;
    }
    throw new AppError('Unable to resolve command path.', {
      code: 'COMMAND_PATH_RESOLUTION_FAILED',
      statusCode: 403,
    });
  }
};

const isPathInside = (basePath, candidatePath) => {
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Resolve a `.claude/commands` directory only when it remains below the
 * authorized project/home root.  Resolving the commands directory itself is
 * not enough: a repository can contain a symlink such as
 * `.claude/commands -> /some/other/checkout`, and treating that resolved path
 * as a fresh trust root would turn command discovery/execution into an
 * arbitrary filesystem read.  Missing directories are returned in lexical
 * form so the normal `access` check can keep treating them as empty.
 */
const resolveAuthorizedCommandsDirectory = async (authorizedRoot) => {
  const canonicalRoot = await canonicalizeExistingPath(authorizedRoot);
  const commandsPath = path.join(authorizedRoot, '.claude', 'commands');
  const canonicalCommandsPath = await canonicalizeExistingPath(commandsPath);
  return isPathInside(canonicalRoot, canonicalCommandsPath)
    ? canonicalCommandsPath
    : null;
};

/**
 * Verifies a custom command file is a direct descendant of an authorized
 * user/project `.claude/commands` directory, including symlink-aware checks.
 */
const resolveAuthorizedCommandPath = async (commandPath, projectPath) => {
  if (typeof commandPath !== 'string' || !commandPath.trim()) {
    return null;
  }

  const resolvedPath = await canonicalizeExistingPath(commandPath);
  const userBase = await resolveAuthorizedCommandsDirectory(os.homedir());
  if (userBase && isPathInside(userBase, resolvedPath)) {
    return resolvedPath;
  }

  if (!projectPath) {
    return null;
  }
  const projectBase = await resolveAuthorizedCommandsDirectory(projectPath);
  return projectBase && isPathInside(projectBase, resolvedPath) ? resolvedPath : null;
};

const sendCommandError = (response, error, fallbackMessage) => {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      error: error.message,
      message: error.message,
      code: error.code,
    });
    return;
  }
  const message = error instanceof Error ? error.message : fallbackMessage;
  response.status(500).json({ error: fallbackMessage, message });
};

/**
 * Removes server-local paths and arbitrary front-matter from command records
 * returned to a product/QA caller.  Read-only users may discover the command
 * names available in a registered project, but an absolute path (or custom
 * metadata copied from a command file) is not part of that read contract and
 * can disclose the service account's filesystem layout.
 */
const sanitizeReadOnlyCommand = (command) => ({
  name: command.name,
  relativePath: command.relativePath,
  description: command.description,
  namespace: command.namespace,
});

/**
 * Slash-command execution can invoke command content containing shell/MCP
 * instructions. It is therefore an interactive-terminal capability, even
 * though the current handler primarily prepares command text. Keep command
 * listing available to product/QA users, but fail closed for execution in the
 * product-qa-readonly profile.
 */
const requireInteractiveTerminal = (req, _res, next) => {
  const policy = resolveDeploymentPolicy(req);
  const allowed = policy.profile !== "product-qa-readonly"
    && ["terminal.interactive", "terminal-interactive", "shell-exec", "local-shell"]
      .some((capability) => hasDeploymentCapability(policy, capability));
  if (!allowed) {
    next(new AppError("Command execution is disabled for this deployment.", {
      code: "DEPLOYMENT_CAPABILITY_DENIED",
      statusCode: 403,
      details: {
        profile: policy.profile,
        capabilities: ["terminal.interactive"],
      },
    }));
    return;
  }
  next();
};

const MODEL_PROVIDERS = ["claude", "cursor", "codex", "opencode"];

const MODEL_PROVIDER_LABELS = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  opencode: "OpenCode",
};

const readModelProvider = (value) => {
  if (typeof value !== "string") {
    return "claude";
  }

  const normalized = value.trim().toLowerCase();
  return MODEL_PROVIDERS.includes(normalized) ? normalized : "claude";
};

/**
 * Resolves the model a command should report.
 *
 * `context.model` is what the composer would send right now, so it stands in
 * for a chat that has no session row yet; the service prefers the session's own
 * recorded model whenever there is one.
 */
const resolveCommandModel = async (modelsService, provider, context) => {
  const resolved = await modelsService.resolveSessionModel(provider, {
    sessionId: context?.sessionId,
    requestedModel: context?.model,
  });
  return resolved.model;
};

const executeModelsCommand = async (args, context, modelsService) => {
  const currentProvider = readModelProvider(context?.provider);
  const catalog = await modelsService.getProviderModels(currentProvider);
  const currentModel = await resolveCommandModel(modelsService, currentProvider, context);
  const availableModels = catalog.OPTIONS.map((option) => option.value);
  const availableOptions = catalog.OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
    recordId: option.recordId,
    isCustom: option.isCustom,
  }));

  return {
    type: "builtin",
    action: "models",
    data: {
      current: {
        provider: currentProvider,
        providerLabel: MODEL_PROVIDER_LABELS[currentProvider],
        model: currentModel,
      },
      available: {
        [currentProvider]: availableModels,
      },
      availableModels,
      availableOptions,
      defaultModel: catalog.DEFAULT,
      message: `Current model: ${currentModel}`,
    },
  };
};

/**
 * Recursively scan directory for command files (.md)
 * @param {string} dir - Directory to scan
 * @param {string} baseDir - Base directory for relative paths
 * @param {string} namespace - Namespace for commands (e.g., 'project', 'user')
 * @returns {Promise<Array>} Array of command objects
 */
async function scanCommandsDirectory(dir, baseDir, namespace, authorizedRoot = baseDir) {
  const commands = [];

  try {
    // Check if directory exists
    await fs.access(dir);

    // Re-resolve each directory immediately before reading it.  A command
    // tree is project-controlled data, so a symlink swap between the caller's
    // root check and this scan must fail closed rather than expose a file from
    // outside the authorized project/home root.
    const canonicalRoot = await canonicalizeExistingPath(authorizedRoot);
    const canonicalBaseDir = await canonicalizeExistingPath(baseDir);
    const canonicalDir = await canonicalizeExistingPath(dir);
    const sameDirectory = path.resolve(canonicalRoot) === path.resolve(canonicalDir);
    const sameCommandTree = path.resolve(canonicalBaseDir) === path.resolve(canonicalDir);
    if ((!sameDirectory && !isPathInside(canonicalRoot, canonicalDir))
      || (!sameCommandTree && !isPathInside(canonicalBaseDir, canonicalDir))) {
      console.warn(`Skipping command directory outside authorized root: ${dir}`);
      return commands;
    }

    // Read the canonical directory rather than the original (possibly
    // symlinked) spelling. This narrows the check/use window and makes nested
    // entries relative to the same trusted tree.
    const entries = await fs.readdir(canonicalDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(canonicalDir, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        const subCommands = await scanCommandsDirectory(
          fullPath,
          baseDir,
          namespace,
          canonicalRoot,
        );
        commands.push(...subCommands);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Parse markdown file for metadata
        try {
          // Dirent.isFile() is only a point-in-time observation. Canonicalize
          // again before opening so a swapped symlink cannot escape the root.
          const canonicalFilePath = await canonicalizeExistingPath(fullPath);
          if (!isPathInside(canonicalBaseDir, canonicalFilePath)) {
            console.warn(`Skipping command file outside authorized root: ${fullPath}`);
            continue;
          }
          const content = await fs.readFile(canonicalFilePath, "utf8");
          const { data: frontmatter, content: commandContent } =
            parseFrontMatter(content);

          // Calculate relative path from baseDir for command name
          const relativePath = path.relative(baseDir, canonicalFilePath);
          // Remove .md extension and convert to command name
          const commandName =
            "/" + relativePath.replace(/\.md$/, "").replace(/\\/g, "/");

          // Extract description from frontmatter or first line of content
          let description = frontmatter.description || "";
          if (!description) {
            const firstLine = commandContent.trim().split("\n")[0];
            description = firstLine.replace(/^#+\s*/, "").trim();
          }

          commands.push({
            name: commandName,
            path: fullPath,
            relativePath,
            description,
            namespace,
            metadata: frontmatter,
          });
        } catch (err) {
          console.error(`Error parsing command file ${fullPath}:`, err.message);
        }
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be accessed - this is okay
    if (err.code !== "ENOENT" && err.code !== "EACCES") {
      console.error(`Error scanning directory ${dir}:`, err.message);
    }
  }

  return commands;
}

/**
 * Built-in commands that are always available
 */
const builtInCommands = [
  {
    name: "/help",
    description: "Show help documentation for Claude Code",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/models",
    description: "View available models for the current provider",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/cost",
    description: "Display token usage information",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/memory",
    description: "Open CLAUDE.md memory file for editing",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/config",
    description: "Open settings and configuration",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/status",
    description: "Show system status and version information",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
];

/**
 * Built-in command handlers
 * Each handler returns { type: 'builtin', action: string, data: any }
 */
const builtInHandlers = {
  "/help": async (args, context) => {
    const helpText = `# Claude Code Commands

## Built-in Commands

${builtInCommands
  .map(
    (cmd) => `### ${cmd.name}
${cmd.description}
`,
  )
  .join("\n")}

## Custom Commands

Custom commands can be created in:
- Project: \`.claude/commands/\` (project-specific)
- User: \`~/.claude/commands/\` (available in all projects)

### Command Syntax

- **Arguments**: Use \`$ARGUMENTS\` for all args or \`$1\`, \`$2\`, etc. for positional
- **File Includes**: Use \`@filename\` to include file contents
- **Bash Commands**: Use \`!command\` to execute bash commands

### Examples

\`\`\`markdown
/mycommand arg1 arg2
\`\`\`
`;

    return {
      type: "builtin",
      action: "help",
      data: {
        content: helpText,
        format: "markdown",
        commands: builtInCommands.map((command) => ({
          name: command.name,
          description: command.description,
          namespace: command.namespace,
        })),
      },
    };
  },

  "/models": (args, context) => executeModelsCommand(args, context, providerModelsService),

  "/cost": async (args, context) => {
    const tokenUsage = context?.tokenUsage || {};
    const provider = readModelProvider(context?.provider);
    const model = await resolveCommandModel(providerModelsService, provider, context);

    const reportedUsed =
      Number(
        tokenUsage.used ?? tokenUsage.totalUsed ?? tokenUsage.total_tokens ?? 0,
      ) || 0;
    const total =
      Number(
        tokenUsage.total ??
          tokenUsage.contextWindow ??
          0,
      ) || 0;
    const normalizedInputValue =
      tokenUsage.inputTokens ??
      tokenUsage.input ??
      tokenUsage.cumulativeInputTokens ??
      tokenUsage.breakdown?.input ??
      tokenUsage.promptTokens;
    const directInputTokens =
      Number(
        normalizedInputValue ??
          tokenUsage.input_tokens ??
          0
      ) || 0;
    const cacheReadTokens =
      Number(
        tokenUsage.cacheReadTokens ??
          tokenUsage.cache_read_input_tokens ??
          tokenUsage.cacheReadInputTokens ??
          0,
      ) || 0;
    const cacheCreationTokens =
      Number(
        tokenUsage.cacheCreationTokens ??
          tokenUsage.cache_creation_input_tokens ??
          tokenUsage.cacheCreationInputTokens ??
          0,
      ) || 0;
    const inputTokens = normalizedInputValue == null
      ? directInputTokens + cacheReadTokens + cacheCreationTokens
      : directInputTokens;
    const outputTokens =
      Number(
        tokenUsage.outputTokens ??
          tokenUsage.output ??
          tokenUsage.output_tokens ??
          tokenUsage.cumulativeOutputTokens ??
          tokenUsage.breakdown?.output ??
          tokenUsage.completionTokens ??
          0,
      ) || 0;
    const computedUsed = inputTokens + outputTokens;
    const hasTokenBreakdown = computedUsed > 0;
    const used = Math.max(reportedUsed, computedUsed);

    return {
      type: "builtin",
      action: "cost",
      data: {
        tokenUsage: {
          used,
          total,
        },
        ...(hasTokenBreakdown
          ? {
              tokenBreakdown: {
                input: inputTokens,
                output: outputTokens,
              },
            }
          : {}),
        provider,
        model,
      },
    };
  },

  "/status": async (args, context) => {
    // Read version from package.json
    const packageJsonPath = path.join(APP_ROOT, "package.json");
    let version = "unknown";
    let packageName = "claude-code-ui";

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf8"),
      );
      version = packageJson.version;
      packageName = packageJson.name;
    } catch (err) {
      console.error("Error reading package.json:", err);
    }

    const uptime = process.uptime();
    const uptimeMinutes = Math.floor(uptime / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeFormatted =
      uptimeHours > 0
        ? `${uptimeHours}h ${uptimeMinutes % 60}m`
        : `${uptimeMinutes}m`;

    const statusProvider = readModelProvider(context?.provider);
    const model = await resolveCommandModel(providerModelsService, statusProvider, context);
    const memoryUsage = process.memoryUsage();

    return {
      type: "builtin",
      action: "status",
      data: {
        version,
        packageName,
        uptime: uptimeFormatted,
        uptimeSeconds: Math.floor(uptime),
        model,
        provider: statusProvider,
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        memoryUsage: {
          rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
          heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        },
      },
    };
  },

  "/memory": async (args, context) => {
    const projectPath = context?.projectPath;

    if (!projectPath) {
      return {
        type: "builtin",
        action: "memory",
        data: {
          error: "No project selected",
          message: "Please select a project to access its CLAUDE.md file",
        },
      };
    }

    const claudeMdPath = path.join(projectPath, "CLAUDE.md");

    // Check if CLAUDE.md exists
    let exists = false;
    try {
      await fs.access(claudeMdPath);
      exists = true;
    } catch (err) {
      // File doesn't exist
    }

    return {
      type: "builtin",
      action: "memory",
      data: {
        path: claudeMdPath,
        exists,
        message: exists
          ? `Opening CLAUDE.md at ${claudeMdPath}`
          : `CLAUDE.md not found at ${claudeMdPath}. Create it to store project-specific instructions.`,
      },
    };
  },

  "/config": async (args, context) => {
    return {
      type: "builtin",
      action: "config",
      data: {
        message: "Opening settings...",
      },
    };
  },
};

/**
 * POST /api/commands/list
 * List all available commands from project and user directories
 */
router.post("/list", async (req, res) => {
  try {
    const policy = resolveDeploymentPolicy(req);
    const readOnly = isDeploymentReadOnly(policy);
    const requestBody = req.body && typeof req.body === 'object'
      ? req.body as Record<string, unknown>
      : {};
    // In a shared read-only deployment an absolute path is safe only when the
    // server can resolve it through its project registry.  A missing resolver
    // is a composition error, not permission to fall back to arbitrary host
    // paths (which would defeat the HOME/filesystem isolation boundary).
    if (readOnly
      && readProjectPath(requestBody)
      && !dependencies.resolveRegisteredProjectPath
      && !dependencies.resolveProjectPathById) {
      throw new AppError('Project path is not registered for this deployment.', {
        code: 'PROJECT_PATH_NOT_REGISTERED',
        statusCode: 403,
      });
    }
    const projectPath = await resolveAuthorizedProjectPath(req.body);
    const allCommands = [...builtInCommands];

    // Scan project-level commands (.claude/commands/)
    if (projectPath) {
      const projectCommandsDir = await resolveAuthorizedCommandsDirectory(projectPath);
      if (projectCommandsDir) {
        const projectCommands = await scanCommandsDirectory(
          projectCommandsDir,
          projectCommandsDir,
          "project",
          projectPath,
        );
        allCommands.push(...projectCommands);
      } else {
        // A symlinked `.claude/commands` root that resolves outside the
        // registered project is untrusted. Do not enumerate it, even if the
        // service account can read the target.
        console.warn(`Skipping project command directory outside authorized root: ${projectPath}`);
      }
    }

    // A read-only deployment is a shared service-account process.  Scanning
    // ~/.claude/commands would enumerate an unrelated operator's home (and
    // expose absolute paths/front-matter), so only commands below the
    // server-registered project are discoverable there. Local developer
    // profiles retain the historical user-command behavior.
    if (!readOnly) {
      const homeDir = os.homedir();
      const userCommandsDir = await resolveAuthorizedCommandsDirectory(homeDir);
      if (userCommandsDir) {
        const userCommands = await scanCommandsDirectory(
          userCommandsDir,
          userCommandsDir,
          "user",
          homeDir,
        );
        allCommands.push(...userCommands);
      } else {
        console.warn(`Skipping user command directory outside authorized home: ${homeDir}`);
      }
    }

    // Separate built-in and custom commands
    const customCommands = allCommands.filter(
      (cmd) => cmd.namespace !== "builtin",
    );

    // Sort commands alphabetically by name
    customCommands.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      builtIn: builtInCommands,
      // Never return absolute command paths or untrusted front-matter to a
      // read-only shared deployment.  Writable local callers need `path` to
      // execute custom commands and therefore receive the legacy records.
      custom: readOnly
        ? customCommands.map(sanitizeReadOnlyCommand)
        : customCommands,
      count: allCommands.length,
    });
  } catch (error) {
    console.error("Error listing commands:", error);
    sendCommandError(res, error, "Failed to list commands");
  }
});

/**
 * POST /api/commands/execute
 * Execute a command with argument replacement
 * This endpoint prepares the command content but doesn't execute bash commands yet
 * (that will be handled in the command parser utility)
 */
router.post("/execute", requireInteractiveTerminal, async (req, res) => {
  try {
    const { commandName, commandPath, args = [], context = {} } = req.body;
    const authorizedProjectPath = await resolveAuthorizedProjectPath(context);
    // Project paths in the browser context are hints only.  Built-in handlers
    // (notably `/memory`) must receive the registry-resolved path as well, or
    // an attacker could bypass the custom-command check with a built-in.
    const authorizedContext = authorizedProjectPath
      ? { ...context, projectPath: authorizedProjectPath }
      : context;

    if (!commandName) {
      return res.status(400).json({
        error: "Command name is required",
      });
    }

    // Handle built-in commands
    const handler = builtInHandlers[commandName];
    if (handler) {
      try {
        const result = await handler(args, authorizedContext);
        return res.json({
          ...result,
          command: commandName,
        });
      } catch (error) {
        console.error(
          `Error executing built-in command ${commandName}:`,
          error,
        );
        return res.status(500).json({
          error: "Command execution failed",
          message: error.message,
          command: commandName,
        });
      }
    }

    // Handle custom commands
    if (!commandPath) {
      return res.status(400).json({
        error: "Command path is required for custom commands",
      });
    }

    // Load command content
    // Security: validate commandPath is within allowed directories
    let authorizedCommandPath = commandPath;
    {
      const canonicalCommandPath = await resolveAuthorizedCommandPath(commandPath, authorizedProjectPath);
      if (!canonicalCommandPath) {
        return res.status(403).json({
          error: "Access denied",
          message: "Command must be in .claude/commands directory",
        });
      }
      // Use the canonical path returned by the containment check to avoid a
      // check/use gap through a swapped symlink.
      authorizedCommandPath = canonicalCommandPath;
    }
    const content = await fs.readFile(authorizedCommandPath, "utf8");
    const { data: metadata, content: commandContent } =
      parseFrontMatter(content);
    // Basic argument replacement (will be enhanced in command parser utility)
    let processedContent = commandContent;

    // Replace $ARGUMENTS with all arguments joined
    const argsString = args.join(" ");
    processedContent = processedContent.replace(/\$ARGUMENTS/g, argsString);

    // Replace $1, $2, etc. with positional arguments
    args.forEach((arg, index) => {
      const placeholder = `$${index + 1}`;
      processedContent = processedContent.replace(
        new RegExp(`\\${placeholder}\\b`, "g"),
        arg,
      );
    });

    res.json({
      type: "custom",
      command: commandName,
      content: processedContent,
      metadata,
      hasFileIncludes: processedContent.includes("@"),
      hasBashCommands: processedContent.includes("!"),
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({
        error: "Command not found",
        message: `Command file not found: ${req.body.commandPath}`,
      });
    }

    console.error("Error executing command:", error);
    sendCommandError(res, error, "Failed to execute command");
  }
});

return router;
}
