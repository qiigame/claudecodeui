import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  closeConnection,
  initializeDatabase,
  notificationChannelEndpointsDb,
  userDb,
} from '@/modules/database/index.js';
import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';

import { handleDesktopNotificationsConnection } from '../websocket/desktop-notifications-websocket.service.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = WebSocket.OPEN;
  readyState: number = WebSocket.OPEN;
  readonly frames: Array<Record<string, unknown>> = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }
}

async function withIsolatedDatabase(run: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'desktop-notifications-ws-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('desktop-notification-user', 'hash');
    await run(Number(user.id));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('desktop notification registration is denied before its endpoint upsert', { concurrency: false }, async () => {
  await withIsolatedDatabase((userId) => {
    const socket = new FakeSocket();
    const readonlyWithoutSessionWrites = parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
      CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'session.write=false',
    });

    handleDesktopNotificationsConnection(
      socket as never,
      { user: { id: userId } } as never,
      { deploymentPolicy: readonlyWithoutSessionWrites },
    );
    socket.emit('message', JSON.stringify({ type: 'register', deviceId: 'blocked-device' }));

    assert.deepEqual(socket.frames[0], {
      type: 'error',
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
      message: 'Desktop notification registration is disabled for this deployment.',
    });
    assert.deepEqual(socket.closeCalls, [{
      code: 1008,
      reason: 'Desktop notification registration is disabled',
    }]);
    assert.equal(notificationChannelEndpointsDb.getEndpoint(userId, 'desktop', 'blocked-device'), null);
  });
});

test('product/QA readonly deployments retain personal desktop notification registration', { concurrency: false }, async () => {
  await withIsolatedDatabase((userId) => {
    const socket = new FakeSocket();
    const readonlyPolicy = parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    });

    handleDesktopNotificationsConnection(
      socket as never,
      { user: { id: userId } } as never,
      { deploymentPolicy: readonlyPolicy },
    );
    socket.emit('message', JSON.stringify({
      type: 'register',
      deviceId: 'qa-device',
      label: 'QA laptop',
      platform: 'darwin',
    }));

    assert.deepEqual(socket.frames[0], {
      type: 'registered',
      deviceId: 'qa-device',
      enabled: true,
    });
    assert.equal(notificationChannelEndpointsDb.getEndpoint(userId, 'desktop', 'qa-device')?.label, 'QA laptop');
    assert.equal(socket.closeCalls.length, 0);
  });
});
