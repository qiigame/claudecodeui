import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(result.user.permissions, { manageSettings: false });
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('password login explicitly returns a non-admin settings capability', async () => {
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => true,
  }));

  const result = await service.login('alice', 'secret12');

  assert.deepEqual(result.user, {
    id: 1,
    username: 'alice',
    permissions: { manageSettings: false },
  });
});

test('password login returns the injected local settings capability', async () => {
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => true,
    getSettingsPermission: () => true,
  }));

  const result = await service.login('alice', 'secret12');

  assert.equal(result.user.permissions?.manageSettings, true);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

test('DingTalk configuration suppresses first-run password setup', () => {
  const service = createAuthService(createDependencies({
    getDingTalkStatus: () => ({
      enabled: true,
      providers: [{ key: 'comic', name: '漫剧团队' }],
    }),
  }));

  assert.deepEqual(service.getStatus(), {
    needsSetup: false,
    isAuthenticated: false,
    dingTalk: {
      enabled: true,
      providers: [{ key: 'comic', name: '漫剧团队' }],
    },
  });
});

test('DingTalk configuration blocks anonymous password registration', async () => {
  const service = createAuthService(createDependencies({
    getDingTalkStatus: () => ({
      enabled: true,
      providers: [{ key: 'comic', name: 'Comic' }],
    }),
  }));

  await assert.rejects(
    service.register('attacker', 'secret12'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'AUTH_REGISTRATION_DISABLED'
      && error.statusCode === 403
    ),
  );
});

test('password login never compares an OAuth-only password marker', async () => {
  let compared = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({
        id: 1,
        username: '张三',
        password_hash: '!dingtalk-oauth:disabled',
      }),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => {
      compared = true;
      return true;
    },
  }));

  await assert.rejects(
    service.login('张三', 'anything'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(compared, false);
});
