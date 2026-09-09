import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { resolveWebSocketDeploymentPolicy } from '@/modules/websocket/services/websocket-server.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: string[];
    closeCalls: Array<{ code?: number; reason?: string }>;
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.frames = [];
  socket.closeCalls = [];
  socket.send = (data: string) => socket.frames.push(data);
  socket.close = (code, reason) => socket.closeCalls.push({ code, reason });
  return socket;
}

async function withReadonlyEnvironment<T>(callback: () => T | PromiseLike<T>): Promise<T> {
  const previousProfile = process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
  const previousCapabilities = process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES;
  process.env.CLOUDCLI_DEPLOYMENT_PROFILE = 'product-qa-readonly';
  delete process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES;
  try {
    return await callback();
  } finally {
    if (previousProfile === undefined) delete process.env.CLOUDCLI_DEPLOYMENT_PROFILE;
    else process.env.CLOUDCLI_DEPLOYMENT_PROFILE = previousProfile;
    if (previousCapabilities === undefined) delete process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES;
    else process.env.CLOUDCLI_DEPLOYMENT_CAPABILITIES = previousCapabilities;
  }
}

test('websocket policy resolver keeps the top-level startup snapshot authoritative', () => {
  const readonlyPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  const developerPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });

  const resolved = resolveWebSocketDeploymentPolicy({
    deploymentPolicy: readonlyPolicy,
    chat: { deploymentPolicy: developerPolicy },
    shell: { deploymentPolicy: developerPolicy },
  });

  assert.equal(resolved.profile, 'product-qa-readonly');
  assert.equal(resolved.capabilities['shell.exec'], false);
  assert.notEqual(resolved, readonlyPolicy);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.capabilities), true);
});

test('websocket policy resolver rejects conflicting legacy chat and shell snapshots', () => {
  const readonlyPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  const developerPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });

  assert.throws(
    () => resolveWebSocketDeploymentPolicy({
      chat: { deploymentPolicy: developerPolicy },
      shell: { deploymentPolicy: readonlyPolicy },
    }),
    {
      code: 'DEPLOYMENT_POLICY_CONFLICT',
      statusCode: 500,
    },
  );
});

test('websocket policy resolver accepts equivalent legacy snapshots even when false keys are omitted', () => {
  const first = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'shell.exec=false',
  });
  const second = {
    profile: 'developer' as const,
    capabilities: {
      ...first.capabilities,
      // An omitted false capability has the same effective authorization as
      // an explicit false value and should not make a legacy host fail closed.
    },
  };
  delete (second.capabilities as Record<string, boolean>)['shell.exec'];

  const resolved = resolveWebSocketDeploymentPolicy({
    chat: { deploymentPolicy: first },
    shell: { deploymentPolicy: second },
  });
  assert.equal(resolved.profile, 'developer');
  assert.equal(resolved.capabilities['shell.exec'], false);
});

test('websocket policy resolver rejects malformed supplied snapshots', () => {
  assert.throws(
    () => resolveWebSocketDeploymentPolicy({
      deploymentPolicy: {
        profile: 'developer',
        capabilities: { 'shell.exec': 'true' },
      } as never,
    }),
    {
      code: 'DEPLOYMENT_POLICY_CONFLICT',
      statusCode: 500,
    },
  );
});

test('direct shell entry resolves product/QA policy from the process environment', async () => {
  await withReadonlyEnvironment(() => {
    const socket = createFakeSocket();
    let spawnCalls = 0;

    handleShellConnection(socket as never, {
      resolveSessionProjectPath: () => process.cwd(),
      resolveProviderSessionId: () => null,
      spawnPty: (() => {
        spawnCalls += 1;
        throw new Error('PTY must not be created in read-only mode');
      }) as never,
    });

    assert.equal(socket.listenerCount('message'), 0);
    assert.equal(spawnCalls, 0);
    assert.equal(JSON.parse(socket.frames[0]!).code, 'DEPLOYMENT_CAPABILITY_DENIED');
    assert.deepEqual(socket.closeCalls, [{
      code: 1008,
      reason: 'Interactive terminal access is disabled',
    }]);
  });
});

test('direct chat entry can explicitly require verified attribution when policy injection is omitted', async () => {
  await withReadonlyEnvironment(async () => {
    const socket = createFakeSocket();
    let runtimeCalls = 0;
    const runtime = {
      hasRuntime: () => {
        runtimeCalls += 1;
        return true;
      },
      run: async () => {
        runtimeCalls += 1;
      },
      abort: async () => false,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    };

    handleChatConnection(
      socket as never,
      {
        user: {
          id: 1,
          actor: {
            provider: 'dingtalk',
            personId: null,
            identityStatus: 'pending',
          },
        },
      } as unknown as AuthenticatedWebSocketRequest,
      { runtime, requireVerifiedDingTalkActor: true },
    );
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: 'alternate-policy-chat',
      content: 'must not execute',
    }));
    await new Promise((resolve) => setImmediate(resolve));

    const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    assert.equal(frames.some((frame) => frame.code === 'IDENTITY_ENROLLMENT_REQUIRED'), true);
    assert.equal(runtimeCalls, 0);
    socket.emit('close');
  });
});
