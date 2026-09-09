import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  getModuleDirectory,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

const THINKINGDATA_MCP_HOST = 'admin-ss.gamehaus.com';
const THINKINGDATA_MCP_PATH_PREFIX = '/mcp/analysis/http/';
const THINKINGDATA_PROXY_SCRIPT = path.join(
  getModuleDirectory(import.meta.url),
  'thinkingdata-mcp-compat-proxy.js',
);

/**
 * Resolves the operator-managed Claude MCP source independently from the
 * isolated transcript/config root. Candidate instances deliberately persist
 * their sessions under COMIC_CLAUDE_CONFIG_DIR while continuing to consume a
 * reviewed host MCP catalog. An explicit path makes that ownership boundary
 * visible; the legacy home-level location remains the compatibility fallback.
 */
function resolveClaudeMcpConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configuredPath = environment.COMIC_CLAUDE_MCP_CONFIG_PATH?.trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  // COMIC_CLAUDE_CONFIG_DIR is used by CloudCLI for transcript isolation;
  // its MCP catalog is intentionally still the reviewed host catalog unless
  // the operator supplies the explicit override above. A plain
  // CLAUDE_CONFIG_DIR, on the other hand, follows Claude Code's native layout.
  const nativeConfigDirectory = environment.CLAUDE_CONFIG_DIR?.trim();
  if (nativeConfigDirectory && !environment.COMIC_CLAUDE_CONFIG_DIR?.trim()) {
    return path.join(path.resolve(nativeConfigDirectory), '.claude.json');
  }

  return path.join(homeDirectory, '.claude.json');
}

function isThinkingDataMcpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === THINKINGDATA_MCP_HOST
      && parsed.pathname.startsWith(THINKINGDATA_MCP_PATH_PREFIX);
  } catch {
    return false;
  }
}

function buildThinkingDataClaudeProxyConfig(url: string): Record<string, unknown> {
  const tokenFilePath = readOptionalString(
    process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE,
  ) ?? readOptionalString(process.env.TE_MCP_TOKEN_FILE);
  return {
    type: 'stdio',
    command: process.execPath,
    args: [THINKINGDATA_PROXY_SCRIPT],
    // Claude's MCP client gives this child the values declared in this env
    // object, but does not reliably inherit arbitrary parent variables. Keep
    // the token value out of the generated --mcp-config payload and pass only
    // a host-owned protected file path plus the direct-launch fallback name.
    env: {
      CLOUDCLI_THINKINGDATA_MCP_URL: url,
      CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV: 'TE_MCP_TOKEN',
      ...(tokenFilePath
        ? { CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE: tokenFilePath }
        : {}),
    },
  };
}

function adaptWebRuntimeServerConfig(rawConfig: unknown): unknown {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return rawConfig;
  }

  const config = rawConfig as Record<string, unknown>;
  if (isThinkingDataMcpUrl(config.url)) {
    return buildThinkingDataClaudeProxyConfig(config.url);
  }
  return rawConfig;
}

export class ClaudeMcpProvider extends McpProvider {
  constructor() {
    super('claude', ['user', 'local', 'project'], ['stdio', 'http', 'sse']);
  }

  /**
   * Supplies the Claude Web runtime with host-owned user MCP definitions.
   * Project `.mcp.json` and project-local definitions stay out of the explicit
   * SDK payload: passing them through `options.mcpServers` bypasses Claude
   * Code's interactive workspace-trust and per-server approval boundary and
   * could execute a repository-controlled stdio command. The Web runtime pairs
   * this with SDK `strictMcpConfig`, so those scopes remain disabled until the
   * app implements an equivalent approval flow.
   */
  async loadWebRuntimeServers(): Promise<Record<string, unknown> | null> {
    const userServers = await this.readScopedServers('user', process.cwd());
    const adaptedServers = Object.fromEntries(
      Object.entries(userServers).map(([name, config]) => [
        name,
        adaptWebRuntimeServerConfig(config),
      ]),
    );
    return Object.keys(adaptedServers).length > 0 ? adaptedServers : null;
  }

  /**
   * Supplies a trusted developer Web runtime with all native Claude MCP
   * scopes. Scope order matches Claude Code's override semantics: user first,
   * then local workspace registration, then the repository project file. This
   * method is intentionally separate from `loadWebRuntimeServers`, which is a
   * product/QA-safe user-only snapshot and must never expose repository-owned
   * stdio commands.
   */
  async loadDeveloperRuntimeServers(
    workspacePath = process.cwd(),
  ): Promise<Record<string, unknown> | null> {
    const mergedServers: Record<string, unknown> = {};
    for (const scope of ['user', 'local', 'project'] as const) {
      const scopedServers = await this.readScopedServers(scope, workspacePath);
      for (const [name, config] of Object.entries(scopedServers)) {
        mergedServers[name] = adaptWebRuntimeServerConfig(config);
      }
    }
    return Object.keys(mergedServers).length > 0 ? mergedServers : null;
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    if (scope === 'project') {
      const filePath = path.join(workspacePath, '.mcp.json');
      const config = await readJsonConfig(filePath);
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const filePath = resolveClaudeMcpConfigPath();
    const config = await readJsonConfig(filePath);
    if (scope === 'user') {
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[workspacePath]) ?? {};
    return readObjectRecord(projectConfig.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    if (scope === 'project') {
      const filePath = path.join(workspacePath, '.mcp.json');
      const config = await readJsonConfig(filePath);
      config.mcpServers = servers;
      await writeJsonConfig(filePath, config);
      return;
    }

    const filePath = resolveClaudeMcpConfigPath();
    const config = await readJsonConfig(filePath);
    if (scope === 'user') {
      config.mcpServers = servers;
      await writeJsonConfig(filePath, config);
      return;
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[workspacePath]) ?? {};
    projectConfig.mcpServers = servers;
    projects[workspacePath] = projectConfig;
    config.projects = projects;
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        type: 'stdio',
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http/sse MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: input.transport,
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'claude',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    if (typeof config.url === 'string') {
      const transport = readOptionalString(config.type) === 'sse' ? 'sse' : 'http';
      return {
        provider: 'claude',
        name,
        scope,
        transport,
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
