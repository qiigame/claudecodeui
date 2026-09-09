import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  appendCodexMcpConfigOverrides,
  appendCodexProviderConfigOverrides,
  createClaudeMcpConfig,
  handleShellConnection,
  terminateProviderShellSession,
} from '@/modules/websocket/services/shell-websocket.service.js';

const resolveTestSessionProjectPath = () => process.cwd();

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    send: (data: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(data);
  return socket;
}

function createFakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    killed: false,
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return { dispose: () => undefined };
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    emitData(data: string) {
      dataListener?.(data);
    },
    emitExit() {
      exitListener?.({ exitCode: 0 });
    },
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

type TestProviderRuntime = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  mcpServers: Record<string, unknown>;
};

// Provider PTY launches intentionally wait for the short handoff window used
// to coalesce duplicate websocket init frames. Tests that resolve a provider
// gate must let that window elapse before asserting on the spawned PTY.
function waitForProviderHandoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

test('a stale socket close cannot detach the socket that replaced it', () => {
  const pty = createFakePty();
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };
  const initMessage = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `stale-close-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
  });

  const firstSocket = createFakeSocket();
  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', initMessage);

  const replacementSocket = createFakeSocket();
  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', initMessage);
  replacementSocket.frames.length = 0;

  // This ordering reproduces a delayed close from a backgrounded mobile tab.
  firstSocket.emit('close');
  pty.emitData('output-after-stale-close');

  assert.equal(pty.killed, false);
  assert.equal(replacementSocket.frames.length, 1);
  assert.match(replacementSocket.frames[0], /output-after-stale-close/);

  pty.emitExit();
});

test('a late exit from a force-restarted PTY cannot remove its replacement', async () => {
  const ptys: ReturnType<typeof createFakePty>[] = [];
  const sessionId = `force-restart-race-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    spawnPty: () => {
      const nextPty = createFakePty();
      ptys.push(nextPty);
      return nextPty as never;
    },
  };
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);

  const init = (forceRestart = false) => socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'test-command',
    forceRestart,
  }));

  init();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ptys.length, 1);
  const oldPty = ptys[0]!;

  socket.frames.length = 0;
  init(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ptys.length, 2);
  const replacementPty = ptys[1]!;

  // The old process can report data/exit after kill() and after the map has
  // been replaced. Neither event may be delivered to or remove the new PTY.
  oldPty.emitData('stale-output');
  oldPty.emitExit();
  assert.equal(replacementPty.killed, false);
  assert.equal(socket.frames.some((frame) => frame.includes('stale-output')), false);

  replacementPty.emitData('replacement-output');
  assert.equal(socket.frames.some((frame) => frame.includes('replacement-output')), true);
  replacementPty.emitExit();
});

test('same session key uses latest-wins pending launch across websocket connections', async () => {
  const launchGates: Array<Deferred<TestProviderRuntime>> = [];
  const launches: string[] = [];
  const sessionId = `pending-cross-ws-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => {
      const gate = createDeferred<TestProviderRuntime>();
      launchGates.push(gate);
      return gate.promise;
    },
    spawnPty: (executable: string) => {
      launches.push(executable);
      return createFakePty() as never;
    },
  };
  const firstSocket = createFakeSocket();
  const replacementSocket = createFakeSocket();
  const runtime = {
    executable: '/opt/cloudcli/claude',
    args: [],
    env: {},
    mcpServers: {},
  };
  const init = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: false,
    provider: 'claude',
  });

  handleShellConnection(firstSocket as never, dependencies);
  firstSocket.emit('message', init);
  await new Promise((resolve) => setImmediate(resolve));

  handleShellConnection(replacementSocket as never, dependencies);
  replacementSocket.emit('message', init);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launchGates.length, 2);

  // Closing the old socket must not cancel the newer pending token.
  firstSocket.emit('close');
  launchGates[0]!.resolve(runtime);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launches, []);

  launchGates[1]!.resolve(runtime);
  await waitForProviderHandoff();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launches, ['/opt/cloudcli/claude']);
});

test('closing the current websocket while runtime resolution is pending spawns no orphan PTY', async () => {
  const gate = createDeferred<TestProviderRuntime>();
  let spawnCount = 0;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => gate.promise,
    spawnPty: () => {
      spawnCount += 1;
      return createFakePty() as never;
    },
  };
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `pending-close-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    hasSession: false,
    provider: 'claude',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  socket.emit('close');
  gate.resolve({ executable: '/opt/cloudcli/claude', args: [], env: {}, mcpServers: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCount, 0);
});

test('a cancelled launch cleans a materialized Claude config after the socket closes', async () => {
  const runtimeGate = createDeferred<TestProviderRuntime>();
  const configGate = createDeferred<{
    path: string;
    environment?: Record<string, string>;
    cleanup: () => Promise<void>;
  }>();
  let cleanupCalls = 0;
  let spawnCount = 0;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => runtimeGate.promise,
    createClaudeMcpConfig: async () => configGate.promise,
    spawnPty: () => {
      spawnCount += 1;
      return createFakePty() as never;
    },
  };
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `pending-config-close-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    hasSession: false,
    provider: 'claude',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  runtimeGate.resolve({ executable: '/opt/cloudcli/claude', args: [], env: {}, mcpServers: {} });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('close');
  configGate.resolve({
    path: '/tmp/stale-claude-config.json',
    cleanup: async () => {
      cleanupCalls += 1;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawnCount, 0);
  assert.equal(cleanupCalls, 1);
});

test('two init messages on one websocket leave only one PTY launch', async () => {
  const launchGates: Array<Deferred<TestProviderRuntime>> = [];
  let spawnCount = 0;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => {
      const gate = createDeferred<TestProviderRuntime>();
      launchGates.push(gate);
      return gate.promise;
    },
    spawnPty: () => {
      spawnCount += 1;
      return createFakePty() as never;
    },
  };
  const socket = createFakeSocket();
  const sessionId = `pending-double-init-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const init = JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: false,
    provider: 'claude',
  });
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', init);
  socket.emit('message', init);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launchGates.length, 2);

  launchGates[0]!.resolve({ executable: '/opt/cloudcli/claude', args: [], env: {}, mcpServers: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCount, 0);
  launchGates[1]!.resolve({ executable: '/opt/cloudcli/claude', args: [], env: {}, mcpServers: {} });
  await waitForProviderHandoff();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCount, 1);
});

test('shell output detects and normalizes a wrapped authentication URL', () => {
  const pty = createFakePty();
  const socket = createFakeSocket();
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    spawnPty: () => pty as never,
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `wrapped-url-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
      initialCommand: 'test-command',
    })
  );
  socket.frames.length = 0;

  pty.emitData("Continue in your browser: https://example.com/authorize?\ncode=abc\x1b[0m");

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const authenticationFrame = frames.find((frame) => frame.type === 'auth_url');
  assert.deepEqual(authenticationFrame, {
    type: 'auth_url',
    url: 'https://example.com/authorize?code=abc',
    autoOpen: false,
  });

  pty.emitExit();
});

test('bypassPermissions launches the bridged Claude executable with child-only credentials', async () => {
  const launches: Array<{
    executable: string;
    args: string[];
    env: Record<string, string | undefined>;
  }> = [];
  const secret = 'claude-child-only-secret';
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/claude',
      args: ['--model', 'kimi-k2.6'],
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3092',
        ANTHROPIC_AUTH_TOKEN: secret,
        CLAUDE_CONFIG_DIR: '/var/lib/cloudcli/claude',
      },
    }),
    spawnPty: (executable: string, args: string | string[], options: { env?: Record<string, string | undefined> }) => {
      launches.push({
        executable,
        args: Array.isArray(args) ? args : [args],
        env: options.env ?? {},
      });
      return createFakePty() as never;
    },
  };

  const bypassSocket = createFakeSocket();
  handleShellConnection(bypassSocket as never, dependencies);
  bypassSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-on-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
      bypassPermissions: true,
    })
  );
  await new Promise((resolve) => setImmediate(resolve));

  const defaultSocket = createFakeSocket();
  handleShellConnection(defaultSocket as never, dependencies);
  defaultSocket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-off-${Date.now()}`,
      hasSession: false,
      provider: 'claude',
    })
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    launches.map(({ executable, args }) => ({ executable, args })),
    [
      {
        executable: '/opt/cloudcli/claude',
        args: ['--model', 'kimi-k2.6', '--dangerously-skip-permissions'],
      },
      {
        executable: '/opt/cloudcli/claude',
        args: ['--model', 'kimi-k2.6'],
      },
    ],
  );
  assert.equal(launches[0].env.ANTHROPIC_AUTH_TOKEN, secret);
  assert.equal(launches[0].env.CLAUDE_CONFIG_DIR, '/var/lib/cloudcli/claude');
  assert.doesNotMatch(JSON.stringify(launches[0].args), new RegExp(secret));
  assert.doesNotMatch(bypassSocket.frames.join('\n'), new RegExp(secret));
});

test('Claude MCP temp config keeps proxy metadata per child and secrets out of disk', async () => {
  const secret = 'claude-mcp-header-secret';
  const temporaryConfig = await createClaudeMcpConfig({
    'te-mcp-analysis': {
      type: 'stdio',
      command: process.execPath,
      args: ['/opt/cloudcli/thinkingdata-mcp-compat-proxy.js'],
      env: {
        CLOUDCLI_THINKINGDATA_MCP_URL:
          'https://admin-ss.gamehaus.com/mcp/analysis/http/analysis',
        CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV: 'TE_MCP_TOKEN',
        CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE: '/var/lib/cloudcli/te-mcp-token',
      },
    },
    'ordinary-http': {
      type: 'http',
      url: 'https://example.test/mcp',
      headers: {
        'mcp-token': secret,
        'x-api-key': 'another-secret',
      },
    },
    'stdio-with-arg-token': {
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--token', 'argument-secret'],
    },
  });

  const directory = path.dirname(temporaryConfig.path);
  try {
    const directoryStats = await fs.stat(directory);
    const fileStats = await fs.stat(temporaryConfig.path);
    assert.equal(directoryStats.mode & 0o777, 0o700);
    assert.equal(fileStats.mode & 0o777, 0o600);

    const fileContents = await fs.readFile(temporaryConfig.path, 'utf8');
    assert.match(fileContents, /CLOUDCLI_THINKINGDATA_MCP_URL/);
    assert.match(fileContents, /"mcp-token":"\$\{CLOUDCLI_SHELL_MCP_ORDINARY_HTTP_MCP_TOKEN\}"/);
    assert.match(fileContents, /"x-api-key":"\$\{CLOUDCLI_SHELL_MCP_ORDINARY_HTTP_X_API_KEY\}"/);
    assert.doesNotMatch(fileContents, new RegExp(secret));
    assert.doesNotMatch(fileContents, /another-secret/);
    assert.equal(temporaryConfig.environment?.CLOUDCLI_SHELL_MCP_ORDINARY_HTTP_MCP_TOKEN, secret);
    assert.equal(
      temporaryConfig.environment?.CLOUDCLI_SHELL_MCP_ORDINARY_HTTP_X_API_KEY,
      'another-secret',
    );
    assert.doesNotMatch(fileContents, /argument-secret/);
    assert.match(fileContents, /"--token","\$\{CLOUDCLI_SHELL_MCP_STDIO_WITH_ARG_TOKEN_ARG_1\}"/);
    assert.equal(
      temporaryConfig.environment?.CLOUDCLI_SHELL_MCP_STDIO_WITH_ARG_TOKEN_ARG_1,
      'argument-secret',
    );
  } finally {
    await temporaryConfig.cleanup();
  }

  await assert.rejects(fs.stat(temporaryConfig.path), { code: 'ENOENT' });
});

test('Claude terminal passes an isolated MCP config and cleans it after PTY exit', async () => {
  const pty = createFakePty();
  const launches: Array<{
    executable: string;
    args: string[];
    env: Record<string, string | undefined>;
  }> = [];
  const mcpConfigPath = path.join(os.tmpdir(), `cloudcli-claude-mcp-test-${Date.now()}.json`);
  let createdServers: Record<string, unknown> | null = null;
  let cleanupCalls = 0;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/claude',
      args: ['--model', 'kimi-k2.6'],
      env: { ANTHROPIC_AUTH_TOKEN: 'child-secret' },
      mcpServers: {
        'te-mcp-analysis': {
          type: 'stdio',
          command: process.execPath,
          args: ['/opt/cloudcli/thinkingdata-mcp-compat-proxy.js'],
          env: {
            CLOUDCLI_THINKINGDATA_MCP_URL:
              'https://admin-ss.gamehaus.com/mcp/analysis/http/analysis',
          },
        },
      },
    }),
    createClaudeMcpConfig: async (servers: Record<string, unknown>) => {
      createdServers = servers;
      return {
        path: mcpConfigPath,
        environment: { CLOUDCLI_SHELL_MCP_TEST: 'child-value' },
        cleanup: async () => {
          cleanupCalls += 1;
        },
      };
    },
    spawnPty: (executable: string, args: string | string[], options: {
      env?: Record<string, string | undefined>;
    }) => {
      launches.push({
        executable,
        args: Array.isArray(args) ? args : [args],
        env: options.env ?? {},
      });
      return pty as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `claude-mcp-flow-${Date.now()}`,
    hasSession: false,
    provider: 'claude',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createdServers?.['te-mcp-analysis'] !== undefined, true);
  assert.deepEqual(launches.map(({ executable, args }) => ({ executable, args })), [{
    executable: '/opt/cloudcli/claude',
    args: [
      '--model',
      'kimi-k2.6',
      `--mcp-config=${mcpConfigPath}`,
      '--strict-mcp-config',
    ],
  }]);
  assert.equal(launches[0].env.CLOUDCLI_SHELL_MCP_TEST, 'child-value');
  assert.doesNotMatch(JSON.stringify(launches[0].args), /child-secret/);
  assert.doesNotMatch(socket.frames.join('\n'), /child-secret/);

  pty.emitExit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1);
});

test('an empty Claude MCP snapshot starts the terminal with strict empty config', async () => {
  const pty = createFakePty();
  let createCalls = 0;
  let spawned = false;
  let spawnedArgs: string[] = [];
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/claude',
      args: [],
      env: {},
      mcpServers: {},
    }),
    createClaudeMcpConfig: async () => {
      createCalls += 1;
      return {
        path: '/tmp/should-not-be-created.json',
        cleanup: async () => undefined,
      };
    },
    spawnPty: (_executable: string, args: string | string[]) => {
      spawned = true;
      spawnedArgs = Array.isArray(args) ? args : [args];
      return pty as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `claude-empty-mcp-${Date.now()}`,
    hasSession: false,
    provider: 'claude',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawned, true);
  assert.equal(createCalls, 1);
  assert.deepEqual(spawnedArgs, [
    '--mcp-config=/tmp/should-not-be-created.json',
    '--strict-mcp-config',
  ]);
  assert.equal(socket.frames.some((frame) => frame.includes('Unable to prepare Claude MCP')), false);
  pty.emitExit();
});

test('bypassPermissions carries through to resumed bridged Claude sessions', async () => {
  const spawnedArguments: string[][] = [];
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => 'resumed-session-id',
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/claude',
      args: ['--model', 'kimi-k2.6'],
      env: {},
    }),
    spawnPty: (_shell: string, args: string | string[]) => {
      spawnedArguments.push(Array.isArray(args) ? args : [args]);
      return createFakePty() as never;
    },
  };

  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      projectPath: process.cwd(),
      sessionId: `bypass-resume-${Date.now()}`,
      hasSession: true,
      provider: 'claude',
      bypassPermissions: true,
    })
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(spawnedArguments, [[
    '--model',
    'kimi-k2.6',
    '--resume',
    'resumed-session-id',
    '--dangerously-skip-permissions',
  ]]);
});

test('bridged Codex receives explicit Dataverse arguments and credentials only in env', async () => {
  const secret = 'codex-child-only-secret';
  let launch: {
    executable: string;
    args: string[];
    env: Record<string, string | undefined>;
  } | null = null;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => 'native-codex-session',
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/codex',
      args: [
        '--model',
        'gpt-5.6-sol',
        '--config',
        'model_provider="dataverse"',
      ],
      env: { OPENAI_API_KEY: secret },
    }),
    spawnPty: (executable: string, args: string | string[], options: { env?: Record<string, string | undefined> }) => {
      launch = {
        executable,
        args: Array.isArray(args) ? args : [args],
        env: options.env ?? {},
      };
      return createFakePty() as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `codex-runtime-${Date.now()}`,
    hasSession: true,
    provider: 'codex',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(launch);
  const capturedLaunch = launch as {
    executable: string;
    args: string[];
    env: Record<string, string | undefined>;
  };
  assert.equal(capturedLaunch.executable, '/opt/cloudcli/codex');
  assert.deepEqual(capturedLaunch.args, [
    '--model',
    'gpt-5.6-sol',
    '--config',
    'model_provider="dataverse"',
    '--search',
    '--sandbox',
    'workspace-write',
    '--config',
    'sandbox_workspace_write.network_access=true',
    '--config',
    'web_search="live"',
    '--config',
    'check_for_update_on_startup=false',
    'resume',
    'native-codex-session',
  ]);
  assert.equal(capturedLaunch.env.OPENAI_API_KEY, secret);
  assert.doesNotMatch(JSON.stringify(capturedLaunch.args), new RegExp(secret));
  assert.doesNotMatch(socket.frames.join('\n'), new RegExp(secret));
});

test('bridged Codex mirrors the SDK credential under CODEX_API_KEY for a PTY', async () => {
  const secret = 'codex-pty-auth-secret';
  let childEnvironment: Record<string, string | undefined> | undefined;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/codex',
      args: [],
      env: { OPENAI_API_KEY: secret },
    }),
    spawnPty: (_executable: string, _args: string | string[], options: {
      env?: Record<string, string | undefined>;
    }) => {
      childEnvironment = options.env;
      return createFakePty() as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `codex-pty-auth-${Date.now()}`,
    hasSession: false,
    provider: 'codex',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(childEnvironment?.OPENAI_API_KEY, secret);
  assert.equal(childEnvironment?.CODEX_API_KEY, secret);
  assert.doesNotMatch(socket.frames.join('\n'), new RegExp(secret));
});

test('Codex terminal keeps network overrides without pinning the active provider', async () => {
  const launches: Array<{ executable: string; args: string[] }> = [];
  const pty = createFakePty();
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => 'resume-without-bridge',
    // This is the shape returned by resolveDataverseProviderRuntime when
    // CC-Switch owns ~/.codex/config.toml: model flags are local, while the
    // provider URL/name remain in the global config and must not be frozen by
    // the shell launch.
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/codex',
      args: ['--model', 'gpt-5.6-sol'],
      env: {},
    }),
    spawnPty: (executable: string, args: string | string[]) => {
      launches.push({
        executable,
        args: Array.isArray(args) ? args : [args],
      });
      return pty as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `codex-no-bridge-${Date.now()}`,
    hasSession: true,
    provider: 'codex',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(launches, [{
    executable: '/opt/cloudcli/codex',
    args: [
      '--model',
      'gpt-5.6-sol',
      '--search',
      '--sandbox',
      'workspace-write',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'web_search="live"',
      '--config',
      'check_for_update_on_startup=false',
      'resume',
      'resume-without-bridge',
    ],
  }]);
  pty.emitExit();
});

test('materializes CC-Switch provider config for an isolated Codex HOME', () => {
  const args: string[] = [];

  appendCodexProviderConfigOverrides(args, {
    model_provider: 'dataverse',
    service_tier: 'fast',
    features: {
      unbounded_connection_retries: false,
      plugins: false,
      remote_plugin: false,
      fast_mode: true,
    },
    model_providers: {
      dataverse: {
        name: 'Dataverse',
        base_url: 'https://ai-agent.dataverse.cn/v1',
        env_key: 'OPENAI_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 2,
        stream_max_retries: 2,
        stream_idle_timeout_ms: 180_000,
      },
    },
  });

  assert.deepEqual(args, [
    '--config',
    'model_provider="dataverse"',
    '--config',
    'service_tier="fast"',
    '--config',
    'features.unbounded_connection_retries=false',
    '--config',
    'features.plugins=false',
    '--config',
    'features.remote_plugin=false',
    '--config',
    'features.fast_mode=true',
    '--config',
    'model_providers.dataverse.name="Dataverse"',
    '--config',
    'model_providers.dataverse.base_url="https://ai-agent.dataverse.cn/v1"',
    '--config',
    'model_providers.dataverse.env_key="OPENAI_API_KEY"',
    '--config',
    'model_providers.dataverse.wire_api="responses"',
    '--config',
    'model_providers.dataverse.requires_openai_auth=true',
    '--config',
    'model_providers.dataverse.request_max_retries=2',
    '--config',
    'model_providers.dataverse.stream_max_retries=2',
    '--config',
    'model_providers.dataverse.stream_idle_timeout_ms=180000',
  ]);
});

test('forwards the runtime bridge MCP snapshot to an isolated Codex terminal', async () => {
  const pty = createFakePty();
  const launches: Array<{ executable: string; args: string[]; env: Record<string, string | undefined> }> = [];
  const browserToken = 'browser-token-must-stay-in-child-env';
  const browserApiUrl = 'http://127.0.0.1:3210/api/browser-use-mcp';
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/codex',
      args: ['--model', 'gpt-5.6-sol'],
      env: {
        OPENAI_API_KEY: 'model-token',
        CLOUDCLI_BROWSER_USE_MCP_TOKEN: browserToken,
        CLOUDCLI_BROWSER_USE_API_URL: browserApiUrl,
      },
      mcpServers: {
        'cloudcli-browser': {
          command: process.execPath,
          args: ['/opt/cloudcli/browser-use-mcp.js'],
          env_vars: ['CLOUDCLI_BROWSER_USE_MCP_TOKEN', 'CLOUDCLI_BROWSER_USE_API_URL'],
          default_tools_approval_mode: 'approve',
        },
      },
    }),
    spawnPty: (executable: string, args: string | string[], options: { env?: Record<string, string | undefined> }) => {
      launches.push({
        executable,
        args: Array.isArray(args) ? args : [args],
        env: options.env ?? {},
      });
      return pty as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `codex-browser-mcp-${Date.now()}`,
    hasSession: false,
    provider: 'codex',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(launches.length, 1);
  const launch = launches[0]!;
  assert.equal(launch.env.CLOUDCLI_BROWSER_USE_MCP_TOKEN, browserToken);
  assert.equal(launch.env.CLOUDCLI_BROWSER_USE_API_URL, browserApiUrl);
  assert.equal(launch.args.includes(browserToken), false);
  assert.equal(launch.args.some((arg) => arg.includes(browserApiUrl)), false);
  assert.equal(
    launch.args.includes('mcp_servers.cloudcli-browser.env_vars=["CLOUDCLI_BROWSER_USE_MCP_TOKEN","CLOUDCLI_BROWSER_USE_API_URL"]'),
    true,
  );
  pty.emitExit();
});

test('flattens the ThinkingData stdio proxy MCP config without putting credentials in argv', () => {
  const args: string[] = [];

  appendCodexMcpConfigOverrides(args, {
    'te-mcp-analysis': {
      command: process.execPath,
      args: ['/opt/cloudcli/thinkingdata-mcp-compat-proxy.js'],
      env: {
        CLOUDCLI_THINKINGDATA_MCP_URL:
          'https://admin-ss.gamehaus.com/mcp/analysis/http/analysis',
        CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV: 'TE_MCP_TOKEN',
        CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE: '/var/lib/cloudcli/te-mcp-token',
      },
      env_vars: [
        'TE_MCP_TOKEN',
        'TE_MCP_TOKEN_FILE',
        'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
      ],
      enabled_tools: ['list_projects'],
      default_tools_approval_mode: 'approve',
      startup_timeout_sec: 10,
      tool_timeout_sec: 120,
    },
  });

  assert.deepEqual(args, [
    '--config',
    'mcp_servers.te-mcp-analysis.command=' + JSON.stringify(process.execPath),
    '--config',
    'mcp_servers.te-mcp-analysis.env.CLOUDCLI_THINKINGDATA_MCP_URL='
      + JSON.stringify('https://admin-ss.gamehaus.com/mcp/analysis/http/analysis'),
    '--config',
    'mcp_servers.te-mcp-analysis.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV="TE_MCP_TOKEN"',
    '--config',
    'mcp_servers.te-mcp-analysis.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE='
      + JSON.stringify('/var/lib/cloudcli/te-mcp-token'),
    '--config',
    'mcp_servers.te-mcp-analysis.args=' + JSON.stringify([
      '/opt/cloudcli/thinkingdata-mcp-compat-proxy.js',
    ]),
    '--config',
    'mcp_servers.te-mcp-analysis.env_vars=' + JSON.stringify([
      'TE_MCP_TOKEN',
      'TE_MCP_TOKEN_FILE',
      'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
    ]),
    '--config',
    'mcp_servers.te-mcp-analysis.enabled_tools=["list_projects"]',
    '--config',
    'mcp_servers.te-mcp-analysis.default_tools_approval_mode="approve"',
    '--config',
    'mcp_servers.te-mcp-analysis.startup_timeout_sec=10',
    '--config',
    'mcp_servers.te-mcp-analysis.tool_timeout_sec=120',
  ]);

  assert.equal(JSON.stringify(args).includes('secret'), false);
});

test('flattens a regular stdio MCP command and preserves inherited env names', () => {
  const args: string[] = [];

  appendCodexMcpConfigOverrides(args, {
    local_tool: {
      command: 'node',
      args: ['server.js', '--mode', 'stdio'],
      cwd: '/workspace/tools',
      env_vars: ['MCP_WORKSPACE', 'MCP_ACCESS_TOKEN'],
      enabled_tools: ['read_file', 'write_file'],
    },
  });

  assert.deepEqual(args, [
    '--config',
    'mcp_servers.local_tool.command="node"',
    '--config',
    'mcp_servers.local_tool.args=["server.js","--mode","stdio"]',
    '--config',
    'mcp_servers.local_tool.env_vars=["MCP_WORKSPACE","MCP_ACCESS_TOKEN"]',
    '--config',
    'mcp_servers.local_tool.enabled_tools=["read_file","write_file"]',
    '--config',
    'mcp_servers.local_tool.cwd="/workspace/tools"',
  ]);
});

test('rejects literal MCP credentials at the shell launch boundary', () => {
  assert.throws(
    () => appendCodexMcpConfigOverrides([], {
      remote: {
        url: 'https://example.test/mcp',
        http_headers: { Authorization: 'Bearer secret-value' },
      },
    }),
    /literal credential/,
  );

  assert.throws(
    () => appendCodexMcpConfigOverrides([], {
      local_tool: {
        command: 'node',
        env: { API_KEY: 'literal-secret' },
      },
    }),
    /unsupported value/,
  );
});

test('the same app session uses separate retained PTYs for Claude and Codex', async () => {
  const launches: string[] = [];
  const sessionId = `provider-switch-${Date.now()}`;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async (provider: 'codex' | 'claude') => ({
      executable: `/opt/cloudcli/${provider}`,
      args: [],
      env: {},
    }),
    spawnPty: (executable: string) => {
      launches.push(executable);
      return createFakePty() as never;
    },
  };

  const claudeSocket = createFakeSocket();
  handleShellConnection(claudeSocket as never, dependencies);
  claudeSocket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: true,
    provider: 'claude',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const codexSocket = createFakeSocket();
  handleShellConnection(codexSocket as never, dependencies);
  codexSocket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: true,
    provider: 'codex',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(launches, ['/opt/cloudcli/claude', '/opt/cloudcli/codex']);
});

test('chat handoff terminates only the matching provider PTY', async () => {
  const ptys: ReturnType<typeof createFakePty>[] = [];
  const sessionId = `chat-handoff-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async (provider: 'codex' | 'claude') => ({
      executable: `/opt/cloudcli/${provider}`,
      args: [],
      env: {},
    }),
    spawnPty: () => {
      const pty = createFakePty();
      ptys.push(pty);
      return pty as never;
    },
  };

  const claudeSocket = createFakeSocket();
  handleShellConnection(claudeSocket as never, dependencies);
  claudeSocket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: true,
    provider: 'claude',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const codexSocket = createFakeSocket();
  handleShellConnection(codexSocket as never, dependencies);
  codexSocket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: true,
    provider: 'codex',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await terminateProviderShellSession(sessionId, 'codex'), 1);
  assert.equal(ptys[0]?.killed, false);
  assert.equal(ptys[1]?.killed, true);
  assert.equal(await terminateProviderShellSession(sessionId, 'codex'), 0);

  // Keep the Claude PTY's lifecycle explicit so this test does not leave a
  // retained process in the module-level map for later tests.
  claudeSocket.emit('close');
  ptys[0]?.emitExit();
});

test('closing a provider shell immediately releases its PTY', async () => {
  const pty = createFakePty();
  const sessionId = `provider-close-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => ({
      executable: '/opt/cloudcli/codex',
      args: [],
      env: {},
    }),
    spawnPty: () => pty as never,
  };
  const socket = createFakeSocket();
  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId,
    hasSession: true,
    provider: 'codex',
  }));
  await new Promise((resolve) => setImmediate(resolve));

  socket.emit('close');
  assert.equal(pty.killed, true);
  assert.equal(await terminateProviderShellSession(sessionId, 'codex'), 0);
});

test('plain shell never invokes the provider runtime resolver', () => {
  let resolverCalls = 0;
  let childEnvironment: Record<string, string | undefined> | undefined;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    resolveProviderRuntime: async () => {
      resolverCalls += 1;
      return {
        executable: '/should/not/run',
        args: [],
        env: { OPENAI_API_KEY: 'must-not-be-injected' },
      };
    },
    spawnPty: (_shell: string, _args: string | string[], options: { env?: Record<string, string | undefined> }) => {
      childEnvironment = options.env;
      return createFakePty() as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: process.cwd(),
    sessionId: `plain-shell-${Date.now()}`,
    hasSession: false,
    provider: 'plain-shell',
    isPlainShell: true,
    initialCommand: 'task-master init',
  }));

  assert.equal(resolverCalls, 0);
  assert.notEqual(childEnvironment?.OPENAI_API_KEY, 'must-not-be-injected');
});

test('an existing session ignores a client-supplied project path', async () => {
  const authoritativePath = process.cwd();
  const requestedPath = path.join(os.tmpdir(), `client-controlled-${Date.now()}`);
  let spawnedCwd = '';
  const pty = createFakePty();
  const dependencies = {
    resolveSessionProjectPath: () => authoritativePath,
    resolveProviderSessionId: () => null,
    spawnPty: (_shell: string, _args: string | string[], options: { cwd?: string }) => {
      spawnedCwd = options.cwd ?? '';
      return pty as never;
    },
  };
  const socket = createFakeSocket();

  handleShellConnection(socket as never, dependencies);
  socket.emit('message', JSON.stringify({
    type: 'init',
    projectPath: requestedPath,
    sessionId: `authoritative-path-${Date.now()}`,
    hasSession: true,
    provider: 'plain-shell',
    isPlainShell: true,
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawnedCwd, authoritativePath);
  assert.notEqual(spawnedCwd, requestedPath);
  pty.emitExit();
});

test('a missing project directory is reported as an error frame and starts no pty', () => {
  const socket = createFakeSocket();
  let spawnCount = 0;
  const dependencies = {
    resolveSessionProjectPath: resolveTestSessionProjectPath,
    resolveProviderSessionId: () => null,
    spawnPty: () => {
      spawnCount += 1;
      return createFakePty() as never;
    },
  };

  handleShellConnection(socket as never, dependencies);
  socket.emit(
    'message',
    JSON.stringify({
      type: 'init',
      // A project row survives its directory being deleted or unmounted, so
      // this is what the Shell tab sends for a stale sidebar entry.
      projectPath: path.join(os.tmpdir(), `shell-missing-${Date.now()}`),
      sessionId: `missing-path-${Date.now()}`,
      hasSession: false,
      provider: 'plain-shell',
      isPlainShell: true,
    })
  );

  assert.equal(spawnCount, 0);
  assert.deepEqual(
    socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>),
    [{ type: 'error', message: 'Invalid project path' }]
  );
});
