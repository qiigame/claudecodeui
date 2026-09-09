import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

import { parseDeploymentPolicy } from '../index.js';

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

test('read-only deployment rejects shell websocket before accepting a PTY init', () => {
  const socket = createFakeSocket();
  let spawnCalls = 0;
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });

  handleShellConnection(socket as never, {
    deploymentPolicy,
    resolveSessionProjectPath: () => process.cwd(),
    resolveProviderSessionId: () => null,
    spawnPty: (() => {
      spawnCalls += 1;
      throw new Error('PTY must not be created in read-only mode');
    }) as never,
  });

  // No message listener should be installed: even a forged plain-shell init
  // cannot reach the PTY launcher after the deployment gate returns.
  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(spawnCalls, 0);
  assert.equal(socket.frames.length, 1);
  assert.deepEqual(JSON.parse(socket.frames[0]!), {
    type: 'error',
    code: 'DEPLOYMENT_CAPABILITY_DENIED',
    message: 'Interactive terminal access is disabled for this deployment.',
  });
  assert.deepEqual(socket.closeCalls, [{
    code: 1008,
    reason: 'Interactive terminal access is disabled',
  }]);
});

test('shell fails closed when the managed actor revalidator throws', () => {
  const socket = createFakeSocket();
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });
  let spawnCalls = 0;

  handleShellConnection(
    socket as never,
    {
      deploymentPolicy,
      requireVerifiedDingTalkActor: true,
      resolveSessionProjectPath: () => process.cwd(),
      resolveProviderSessionId: () => null,
      spawnPty: (() => {
        spawnCalls += 1;
        throw new Error('PTY must not be created after an indeterminate identity check');
      }) as never,
      isActorVerified: () => {
        throw new Error('identity registry unavailable');
      },
    },
    {
      user: {
        id: 1,
        actor: {
          provider: 'dingtalk',
          personId: 'person-1',
          identityStatus: 'verified',
        },
      },
    } as unknown as AuthenticatedWebSocketRequest,
  );

  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(spawnCalls, 0);
  assert.deepEqual(JSON.parse(socket.frames[0]!), {
    type: 'error',
    code: 'IDENTITY_ENROLLMENT_REQUIRED',
    message: 'A verified DingTalk project identity is required before starting a terminal.',
  });
  assert.deepEqual(socket.closeCalls, [{
    code: 1008,
    reason: 'Verified DingTalk identity required',
  }]);
});

test('chat websocket keeps subscriptions when chat/provider capabilities are disabled', async () => {
  const socket = createFakeSocket();
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    // Chat execution can be disabled independently of authenticated session
    // reads. A pure-read client must still be able to subscribe and replay
    // existing gateway events without touching a provider runtime.
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'chat.use=false,provider.runtime=false',
  });
  const runtime = {
    hasRuntime: () => {
      throw new Error('Runtime lookup must not run for a pure-read websocket');
    },
    run: async () => { throw new Error('run must not be called'); },
    abort: async () => { throw new Error('abort must not be called'); },
    resolveToolApproval: () => { throw new Error('approval must not be called'); },
    getPendingApprovalsForSession: () => {
      throw new Error('pending approvals must not be queried without provider.runtime');
    },
  };

  handleChatConnection(
    socket as never,
    {} as AuthenticatedWebSocketRequest,
    { runtime, deploymentPolicy },
  );

  assert.equal(socket.listenerCount('message'), 1);
  assert.equal(socket.frames.length, 0);
  socket.emit('message', JSON.stringify({
    type: 'chat.subscribe',
    sessions: [{ sessionId: 'pure-read-session' }],
  }));
  socket.emit('message', JSON.stringify({
    type: 'chat.send', sessionId: 'pure-read-session', content: 'blocked',
  }));
  socket.emit('message', JSON.stringify({
    type: 'chat.abort', sessionId: 'pure-read-session',
  }));
  socket.emit('message', JSON.stringify({
    type: 'chat.permission-response', requestId: 'pure-read-approval', allow: false,
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.equal(frames.filter((frame) => frame.kind === 'chat_subscribed').length, 1);
  assert.equal(frames.filter((frame) => frame.code === 'DEPLOYMENT_CAPABILITY_DENIED').length, 3);
  assert.deepEqual(socket.closeCalls, []);
  socket.emit('close');
});

test('policy-only readonly chat admission can opt into verified actor execution', async () => {
  const socket = createFakeSocket();
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  let runCalls = 0;
  const runtime = {
    hasRuntime: () => {
      throw new Error('Runtime lookup must not run before actor admission');
    },
    run: async () => { runCalls += 1; },
    abort: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  };

  // A direct/embedded caller can explicitly require named attribution while
  // still exposing the read transport. Authentication alone no longer implies
  // this gate for ordinary chat.
  handleChatConnection(socket as never, {
    user: {
      id: 1,
      actor: {
        provider: 'dingtalk',
        personId: null,
        identityStatus: 'pending',
      },
    },
  } as unknown as AuthenticatedWebSocketRequest, {
    runtime,
    deploymentPolicy,
    requireVerifiedDingTalkActor: true,
  });
  assert.equal(socket.listenerCount('message'), 1);

  socket.emit('message', JSON.stringify({
    type: 'chat.subscribe',
    sessions: [{ sessionId: 'policy-only-read' }],
  }));
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId: 'policy-only-read',
    content: 'must require verified actor',
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const frames = socket.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  assert.equal(frames.some((frame) => frame.kind === 'chat_subscribed'), true);
  assert.equal(frames.some((frame) => frame.code === 'IDENTITY_ENROLLMENT_REQUIRED'), true);
  assert.equal(runCalls, 0);
  socket.emit('close');
});

test('chat subscriptions require session.read even when chat/provider are enabled', () => {
  const socket = createFakeSocket();
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'session.read=false',
  });
  const runtime = {
    hasRuntime: () => {
      throw new Error('Runtime lookup must not run for a denied read transport');
    },
    run: async () => undefined,
    abort: async () => false,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
  };

  handleChatConnection(socket as never, {} as AuthenticatedWebSocketRequest, {
    runtime,
    deploymentPolicy,
  });

  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(JSON.parse(socket.frames[0]!).code, 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.deepEqual(socket.closeCalls, [{
    code: 1008,
    reason: 'Chat runtime access is disabled',
  }]);
});

test('chat execution frames require session.write while subscriptions remain available', async () => {
  const socket = createFakeSocket();
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'session.write=false',
  });
  let runCalls = 0;
  let abortCalls = 0;
  let approvalCalls = 0;
  const runtime = {
    hasRuntime: () => {
      throw new Error('Runtime lookup must not run for a denied execution frame');
    },
    run: async () => { runCalls += 1; },
    abort: async () => { abortCalls += 1; return true; },
    resolveToolApproval: () => { approvalCalls += 1; },
    getPendingApprovalsForSession: () => [],
  };

  handleChatConnection(socket as never, {} as AuthenticatedWebSocketRequest, {
    runtime,
    deploymentPolicy,
  });
  assert.equal(socket.listenerCount('message'), 1);

  socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [] }));
  socket.emit('message', JSON.stringify({
    type: 'chat.send', sessionId: 'write-disabled', content: 'blocked',
  }));
  socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: 'write-disabled' }));
  socket.emit('message', JSON.stringify({
    type: 'chat.permission-response', requestId: 'write-disabled-approval', allow: false,
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const errors = socket.frames
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.code === 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.equal(errors.length, 3);
  assert.equal(runCalls, 0);
  assert.equal(abortCalls, 0);
  assert.equal(approvalCalls, 0);
  assert.deepEqual(socket.closeCalls, []);
  socket.emit('close');
});

test('explicit verified-identity chat policy rejects pending actors', async () => {
  const socket = createFakeSocket();
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  let runCalls = 0;
  let abortCalls = 0;
  let approvalCalls = 0;
  const runtime = {
    hasRuntime: () => true,
    run: async () => { runCalls += 1; },
    abort: async () => { abortCalls += 1; return true; },
    resolveToolApproval: () => { approvalCalls += 1; },
    getPendingApprovalsForSession: () => [],
  };
  const request = {
    user: {
      id: 1,
      actor: {
        provider: 'dingtalk',
        personId: null,
        identityStatus: 'pending',
      },
    },
  } as unknown as AuthenticatedWebSocketRequest;

  handleChatConnection(
    socket as never,
    request,
    {
      runtime,
      deploymentPolicy,
      requireDingTalkActor: true,
      requireVerifiedDingTalkActor: true,
    },
  );

  assert.equal(socket.listenerCount('message'), 1);
  socket.emit('message', JSON.stringify({
    type: 'chat.subscribe',
    sessions: [],
  }));
  socket.emit('message', JSON.stringify({
    type: 'chat.send',
    sessionId: 'pending-session',
    content: 'must be rejected',
  }));
  socket.emit('message', JSON.stringify({
    type: 'chat.abort',
    sessionId: 'pending-session',
  }));
  socket.emit('message', JSON.stringify({
    type: 'chat.permission-response',
    requestId: 'pending-approval',
    allow: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const errors = socket.frames
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.code === 'IDENTITY_ENROLLMENT_REQUIRED');
  assert.equal(errors.length, 3);
  assert.equal(runCalls, 0);
  assert.equal(abortCalls, 0);
  assert.equal(approvalCalls, 0);
  assert.deepEqual(socket.closeCalls, []);
});

test('chat revalidates a previously verified actor before each approval operation', async () => {
  const socket = createFakeSocket();
  const deploymentPolicy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });
  let actorVerified = true;
  let approvalCalls = 0;
  const runtime = {
    hasRuntime: () => true,
    run: async () => undefined,
    abort: async () => false,
    resolveToolApproval: () => { approvalCalls += 1; },
    getPendingApprovalsForSession: () => [],
  };

  handleChatConnection(
    socket as never,
    {
      user: {
        id: 1,
        actor: {
          provider: 'dingtalk',
          personId: 'person-1',
          identityStatus: 'verified',
        },
      },
    } as unknown as AuthenticatedWebSocketRequest,
    {
      runtime,
      deploymentPolicy,
      requireVerifiedDingTalkActor: true,
      isActorVerified: () => actorVerified,
    },
  );

  socket.emit('message', JSON.stringify({
    type: 'chat.permission-response',
    requestId: 'approval-1',
    allow: false,
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(approvalCalls, 1);

  actorVerified = false;
  socket.emit('message', JSON.stringify({
    type: 'chat.permission-response',
    requestId: 'approval-2',
    allow: false,
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(approvalCalls, 1);
  const lastFrame = JSON.parse(socket.frames.at(-1)!) as Record<string, unknown>;
  assert.equal(lastFrame.code, 'IDENTITY_ENROLLMENT_REQUIRED');
});
