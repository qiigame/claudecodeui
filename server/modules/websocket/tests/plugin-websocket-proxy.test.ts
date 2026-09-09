import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';

import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';

class FakeClientSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  frames: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.frames.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }
}

test('plugin websocket fails closed before opening upstream for a revoked actor', () => {
  const client = new FakeClientSocket();

  handlePluginWsProxy(
    client as unknown as WebSocket,
    '/plugin-ws/project-stats',
    () => 43123,
    { isExecutionAllowed: () => false },
  );

  const frame = JSON.parse(client.frames[0]!) as Record<string, unknown>;
  assert.equal(frame.kind, 'protocol_error');
  assert.equal(frame.code, 'IDENTITY_ENROLLMENT_REQUIRED');
  assert.equal(frame.error, 'A verified DingTalk project identity is required before using plugins.');
  assert.equal(frame.sessionId, null);
  assert.equal(typeof frame.timestamp, 'string');
  assert.deepEqual(client.closeCalls, [{
    code: 1008,
    reason: 'Verified DingTalk identity required',
  }]);
});

test('managed plugin proxy fails closed when no dynamic admission callback is supplied', () => {
  const client = new FakeClientSocket();

  handlePluginWsProxy(
    client as unknown as WebSocket,
    '/plugin-ws/project-stats',
    () => 43123,
    { requireExecutionAdmission: true },
  );

  const frame = JSON.parse(client.frames[0]!) as Record<string, unknown>;
  assert.equal(frame.kind, 'protocol_error');
  assert.equal(frame.code, 'IDENTITY_ENROLLMENT_REQUIRED');
  assert.deepEqual(client.closeCalls, [{
    code: 1008,
    reason: 'Verified DingTalk identity required',
  }]);
});
