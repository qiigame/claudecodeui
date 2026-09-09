import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';

const patchHomeDirectory = (homeDirectory: string) => {
  const originalHomeDirectory = os.homedir;
  (os as typeof os & { homedir: () => string }).homedir = () => homeDirectory;
  return () => {
    (os as typeof os & { homedir: () => string }).homedir = originalHomeDirectory;
  };
};

test('Claude Web runtime loads only host-owned user MCP servers', {
  concurrency: false,
}, async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-mcp-'));
  const workspacePath = path.join(temporaryHome, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const restoreHomeDirectory = patchHomeDirectory(temporaryHome);
  const provider = new ClaudeMcpProvider();

  try {
    await provider.upsertServer({
      name: 'user-server',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['user-server.js'],
    });
    await provider.upsertServer({
      name: 'project-server',
      scope: 'project',
      transport: 'stdio',
      command: 'node',
      args: ['repository-controlled-server.js'],
      workspacePath,
    });
    await provider.upsertServer({
      name: 'local-server',
      scope: 'local',
      transport: 'sse',
      url: 'https://local.example/sse',
      workspacePath,
    });

    for (const [scope, url] of [
      ['user', 'https://user.example/shared'],
      ['project', 'https://project.example/shared'],
      ['local', 'https://local.example/shared'],
    ] as const) {
      await provider.upsertServer({
        name: 'shared-name',
        scope,
        transport: 'http',
        url,
        workspacePath,
      });
    }

    const runtimeServers = await provider.loadWebRuntimeServers();

    assert.ok(runtimeServers);
    assert.ok(runtimeServers?.['user-server']);
    assert.equal(runtimeServers?.['project-server'], undefined);
    assert.equal(runtimeServers?.['local-server'], undefined);
    assert.equal(
      (runtimeServers['shared-name'] as Record<string, unknown>).url,
      'https://user.example/shared',
    );
  } finally {
    restoreHomeDirectory();
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});

test('Claude Web runtime routes ThinkingData HTTP MCP servers through the schema compatibility proxy', {
  concurrency: false,
}, async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-thinkingdata-'));
  const restoreHomeDirectory = patchHomeDirectory(temporaryHome);
  const originalTokenFilePath = process.env.TE_MCP_TOKEN_FILE;
  process.env.TE_MCP_TOKEN_FILE = '/secure/cloudcli/thinkingdata-mcp-token';
  const provider = new ClaudeMcpProvider();

  try {
    await provider.upsertServer({
      name: 'te-mcp-analysis',
      scope: 'user',
      transport: 'http',
      url: 'https://admin-ss.gamehaus.com/mcp/analysis/http/analysis',
      headers: { 'mcp-token': '${TE_MCP_TOKEN}' },
    });
    await provider.upsertServer({
      name: 'ordinary-http-server',
      scope: 'user',
      transport: 'http',
      url: 'https://example.invalid/mcp',
      headers: { authorization: 'Bearer placeholder' },
    });

    const runtimeServers = await provider.loadWebRuntimeServers();
    const thinkingData = runtimeServers?.['te-mcp-analysis'] as Record<string, unknown>;
    const ordinary = runtimeServers?.['ordinary-http-server'] as Record<string, unknown>;

    assert.equal(thinkingData.type, 'stdio');
    assert.equal(thinkingData.command, process.execPath);
    assert.deepEqual(thinkingData.env, {
      CLOUDCLI_THINKINGDATA_MCP_URL: 'https://admin-ss.gamehaus.com/mcp/analysis/http/analysis',
      CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV: 'TE_MCP_TOKEN',
      CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE: '/secure/cloudcli/thinkingdata-mcp-token',
    });
    assert.ok(Array.isArray(thinkingData.args));
    assert.match(String(thinkingData.args?.[0]), /thinkingdata-mcp-compat-proxy\.js$/);
    assert.equal(ordinary.type, 'http');
    assert.equal(ordinary.url, 'https://example.invalid/mcp');
  } finally {
    if (originalTokenFilePath === undefined) {
      delete process.env.TE_MCP_TOKEN_FILE;
    } else {
      process.env.TE_MCP_TOKEN_FILE = originalTokenFilePath;
    }
    restoreHomeDirectory();
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});

test('Claude MCP catalog can be isolated explicitly from the transcript config root', {
  concurrency: false,
}, async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-mcp-override-'));
  const mcpConfigPath = path.join(temporaryHome, 'operator-mcp.json');
  const previousMcpConfigPath = process.env.COMIC_CLAUDE_MCP_CONFIG_PATH;
  process.env.COMIC_CLAUDE_MCP_CONFIG_PATH = mcpConfigPath;
  const provider = new ClaudeMcpProvider();

  try {
    await provider.upsertServer({
      name: 'isolated-catalog-server',
      scope: 'user',
      transport: 'http',
      url: 'https://example.invalid/isolated',
    });

    const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.ok(config.mcpServers?.['isolated-catalog-server']);
    assert.equal(
      (await provider.loadWebRuntimeServers())?.['isolated-catalog-server']
        ? true
        : false,
      true,
    );
  } finally {
    if (previousMcpConfigPath === undefined) {
      delete process.env.COMIC_CLAUDE_MCP_CONFIG_PATH;
    } else {
      process.env.COMIC_CLAUDE_MCP_CONFIG_PATH = previousMcpConfigPath;
    }
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});

test('Claude MCP keeps using the reviewed host catalog when transcript storage is isolated', {
  concurrency: false,
}, async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-mcp-host-fallback-'));
  const isolatedConfigDirectory = path.join(temporaryHome, 'isolated-claude');
  const previousTranscriptDirectory = process.env.COMIC_CLAUDE_CONFIG_DIR;
  const previousMcpConfigPath = process.env.COMIC_CLAUDE_MCP_CONFIG_PATH;
  process.env.COMIC_CLAUDE_CONFIG_DIR = isolatedConfigDirectory;
  delete process.env.COMIC_CLAUDE_MCP_CONFIG_PATH;
  const restoreHomeDirectory = patchHomeDirectory(temporaryHome);
  const provider = new ClaudeMcpProvider();

  try {
    await fs.writeFile(
      path.join(temporaryHome, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'host-reviewed-server': {
            type: 'http',
            url: 'https://example.invalid/reviewed',
          },
        },
      }),
      'utf8',
    );

    const runtimeServers = await provider.loadWebRuntimeServers();
    assert.ok(runtimeServers?.['host-reviewed-server']);
    assert.equal(
      runtimeServers?.['host-reviewed-server'] &&
        (runtimeServers['host-reviewed-server'] as Record<string, unknown>).url,
      'https://example.invalid/reviewed',
    );
  } finally {
    restoreHomeDirectory();
    if (previousTranscriptDirectory === undefined) {
      delete process.env.COMIC_CLAUDE_CONFIG_DIR;
    } else {
      process.env.COMIC_CLAUDE_CONFIG_DIR = previousTranscriptDirectory;
    }
    if (previousMcpConfigPath === undefined) {
      delete process.env.COMIC_CLAUDE_MCP_CONFIG_PATH;
    } else {
      process.env.COMIC_CLAUDE_MCP_CONFIG_PATH = previousMcpConfigPath;
    }
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});

test('trusted developer Claude runtime preserves user, local, and project MCP scopes', {
  concurrency: false,
}, async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-developer-mcp-'));
  const workspacePath = path.join(temporaryHome, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const restoreHomeDirectory = patchHomeDirectory(temporaryHome);
  const provider = new ClaudeMcpProvider();

  try {
    await provider.upsertServer({
      name: 'user-server',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['user-server.js'],
    });
    await provider.upsertServer({
      name: 'local-server',
      scope: 'local',
      transport: 'stdio',
      command: 'node',
      args: ['local-server.js'],
      workspacePath,
    });
    await provider.upsertServer({
      name: 'project-server',
      scope: 'project',
      transport: 'stdio',
      command: 'node',
      args: ['project-server.js'],
      workspacePath,
    });
    await provider.upsertServer({
      name: 'shared-name',
      scope: 'user',
      transport: 'http',
      url: 'https://user.example/mcp',
      workspacePath,
    });
    await provider.upsertServer({
      name: 'shared-name',
      scope: 'project',
      transport: 'http',
      url: 'https://project.example/mcp',
      workspacePath,
    });

    const runtimeServers = await provider.loadDeveloperRuntimeServers(workspacePath);

    assert.ok(runtimeServers);
    assert.ok(runtimeServers?.['user-server']);
    assert.ok(runtimeServers?.['local-server']);
    assert.ok(runtimeServers?.['project-server']);
    assert.equal(
      (runtimeServers['shared-name'] as Record<string, unknown>).url,
      'https://project.example/mcp',
    );
  } finally {
    restoreHomeDirectory();
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});
