import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  canManageSettings,
  createSettingsAdminRouteGuard,
  isSettingsAdminRoute,
  normalizeRoutePath,
  parseSettingsAdminUserIds,
  withSettingsPermissions,
} from '../settings-access.middleware.js';

const trustedAdmin = {
  id: 7,
  username: '赵井渝',
  actor: {
    actorId: 11,
    userId: 7,
    displayName: '赵井渝',
    badge: '赵',
    provider: 'dingtalk',
    providerName: '灏瀚',
    personId: 'zhaojingyu',
    identityStatus: 'verified',
  },
};

test('numeric admin allowlist parsing ignores malformed entries and deduplicates ids', () => {
  assert.deepEqual([...parseSettingsAdminUserIds(' 7,8,7,0,-1,1.5,1e2,0x7,nope, ')], [7, 8]);
  assert.deepEqual([...parseSettingsAdminUserIds(undefined)], []);
});

test('settings capability requires both the matching trusted DingTalk actor and allowlisted user id', () => {
  assert.equal(canManageSettings(trustedAdmin, '7, 8'), true);
  assert.equal(canManageSettings(trustedAdmin, '8'), false);
  assert.equal(canManageSettings({ ...trustedAdmin, actor: { ...trustedAdmin.actor, provider: 'local' } }, '7'), false);
  assert.equal(canManageSettings({ ...trustedAdmin, actor: { ...trustedAdmin.actor, userId: 8 } }, '7'), false);
  assert.equal(canManageSettings({ id: 7, username: '赵井渝' }, '7'), false);
  assert.equal(canManageSettings({
    ...trustedAdmin,
    actor: { ...trustedAdmin.actor, identityStatus: 'pending' },
  }, '7'), false);
  assert.equal(canManageSettings({
    ...trustedAdmin,
    actor: { ...trustedAdmin.actor, personId: null },
  }, '7'), false);
  assert.equal(canManageSettings(null, '7'), false);
});

test('local profiles grant settings capability to the authenticated local account', () => {
  for (const profile of ['developer', 'development', 'self-hosted', 'test'] as const) {
    assert.equal(canManageSettings({ id: 9, username: 'local' }, {
      configuredUserIds: '',
      deploymentProfile: profile,
    }), true, profile);
    assert.equal(withSettingsPermissions({ id: 9, username: 'local' }, {
      configuredUserIds: '',
      deploymentProfile: profile,
    }).permissions?.manageSettings, true, profile);
  }
  assert.equal(canManageSettings({ username: 'malformed' }, {
    deploymentProfile: 'developer',
  }), false);
});

test('managed profiles never inherit the local settings capability', () => {
  for (const profile of ['platform', 'production', 'product-qa-readonly'] as const) {
    assert.equal(canManageSettings({ id: 9, username: 'local' }, {
      configuredUserIds: '9',
      deploymentProfile: profile,
    }), false, profile);
  }
});

test('user decorator preserves fields and overwrites any client-like permission with server truth', () => {
  assert.deepEqual(withSettingsPermissions({
    ...trustedAdmin,
    permissions: { existing: true, manageSettings: false },
  }, '7'), {
    ...trustedAdmin,
    permissions: { existing: true, manageSettings: true },
  });
  assert.deepEqual(withSettingsPermissions({ id: 9, permissions: { manageSettings: true } }, '7'), {
    id: 9,
    permissions: { manageSettings: false },
  });
});

test('route matrix guards settings writes and only the requested mutations in mixed routers', () => {
  const guarded: Array<[Parameters<typeof isSettingsAdminRoute>[0], string, string]> = [
    ['settings', 'POST', '/credentials'],
    ['settings', 'DELETE', '/api-keys/1'],
    ['user', 'POST', '/git-config'],
    ['plugins', 'PUT', '/project-stats/enable'],
    ['plugins', 'POST', '/install'],
    ['plugins', 'POST', '/project-stats/update'],
    ['plugins', 'DELETE', '/project-stats'],
    ['providers', 'POST', '/codex/models'],
    ['providers', 'PATCH', '/claude/models/1'],
    ['providers', 'DELETE', '/codex/skills/example'],
    ['providers', 'POST', '/claude/mcp/servers'],
    ['providers', 'DELETE', '/claude/mcp/servers/example'],
    ['providers', 'POST', '/mcp/servers/global'],
    ['browser', 'PUT', '/settings'],
    ['browser', 'POST', '/runtime/install'],
    ['system', 'POST', '/update'],
  ];
  for (const [scope, method, path] of guarded) {
    assert.equal(isSettingsAdminRoute(scope, method, path), true, `${scope} ${method} ${path}`);
  }

  const unguarded: typeof guarded = [
    ['settings', 'GET', '/credentials'],
    ['user', 'GET', '/git-config'],
    ['user', 'PATCH', '/preferences'],
    ['user', 'PUT', '/drafts'],
    ['plugins', 'GET', '/'],
    ['plugins', 'GET', '/project-stats/manifest'],
    ['plugins', 'DELETE', '/project-stats/rpc/data'],
    ['providers', 'POST', '/sessions'],
    ['providers', 'POST', '/codex/sessions/id/active-model'],
    ['providers', 'DELETE', '/sessions/id'],
    ['browser', 'POST', '/sessions/id/stop'],
    ['browser', 'DELETE', '/sessions/id'],
    ['system', 'GET', '/status'],
  ];
  for (const [scope, method, path] of unguarded) {
    assert.equal(isSettingsAdminRoute(scope, method, path), false, `${scope} ${method} ${path}`);
  }
});

test('settings admin route matching is case-insensitive and ignores trailing separators', () => {
  const guarded: Array<[Parameters<typeof isSettingsAdminRoute>[0], string, string]> = [
    ['settings', 'POST', '/CREDENTIALS/'],
    ['providers', 'POST', '/CODEX/MCP/SERVERS/'],
    ['plugins', 'DELETE', '/PROJECT-STATS/'],
    ['browser', 'POST', '/RUNTIME/INSTALL/'],
    ['system', 'POST', '/UPDATE/'],
  ];

  for (const [scope, method, routePath] of guarded) {
    assert.equal(isSettingsAdminRoute(scope, method, routePath), true, `${scope} ${method} ${routePath}`);
  }
});

test('route canonicalizer matches Express effective spelling', () => {
  assert.equal(normalizeRoutePath('/PUSH/SUBSCRIBE/'), '/push/subscribe');
  assert.equal(normalizeRoutePath('//Preferences///?ignored=1'), '/preferences');
  assert.equal(normalizeRoutePath('/'), '/');
});

test('managed-profile route guard fails closed with stable 403 code and passes admin or ordinary reads', () => {
  const guard = createSettingsAdminRouteGuard('settings', '7', 'product-qa-readonly');
  let denied: unknown;
  guard(
    { method: 'POST', path: '/credentials', user: undefined } as never,
    {} as never,
    (error?: unknown) => { denied = error; },
  );
  assert.ok(denied instanceof AppError);
  assert.equal(denied.code, 'SETTINGS_ACCESS_DENIED');
  assert.equal(denied.statusCode, 403);

  let adminError: unknown = 'not-called';
  guard(
    { method: 'POST', path: '/credentials', user: trustedAdmin } as never,
    {} as never,
    (error?: unknown) => { adminError = error; },
  );
  assert.equal(adminError, undefined);

  let readError: unknown = 'not-called';
  guard(
    { method: 'GET', path: '/credentials', user: undefined } as never,
    {} as never,
    (error?: unknown) => { readError = error; },
  );
  assert.equal(readError, undefined);
});

test('local profiles retain settings mutations without a DingTalk admin actor', () => {
  for (const profile of ['developer', 'development', 'self-hosted', 'test'] as const) {
    const guard = createSettingsAdminRouteGuard('settings', '7', profile);
    let guardError: unknown = 'not-called';
    guard(
      {
        method: 'POST',
        path: '/credentials',
        user: { id: 9, username: 'local-developer' },
      } as never,
      {} as never,
      (error?: unknown) => { guardError = error; },
    );
    assert.equal(guardError, undefined, profile);
  }
});

test('all managed profiles require the verified DingTalk admin identity', () => {
  for (const profile of ['platform', 'production', 'product-qa-readonly'] as const) {
    const guard = createSettingsAdminRouteGuard('settings', '7', profile);
    let denied: unknown;
    guard(
      {
        method: 'POST',
        path: '/credentials',
        user: { id: 7, username: 'local-account' },
      } as never,
      {} as never,
      (error?: unknown) => { denied = error; },
    );
    assert.ok(denied instanceof AppError, profile);
    assert.equal(denied.code, 'SETTINGS_ACCESS_DENIED', profile);

    let adminError: unknown = 'not-called';
    guard(
      { method: 'POST', path: '/credentials', user: trustedAdmin } as never,
      {} as never,
      (error?: unknown) => { adminError = error; },
    );
    assert.equal(adminError, undefined, profile);
  }
});

test('developer profile with explicit DingTalk SSO still uses the managed admin boundary', () => {
  const policy = {
    deploymentProfile: 'developer' as const,
    requiresDingTalk: true,
    configuredUserIds: '7',
  };
  assert.equal(canManageSettings(trustedAdmin, policy), true);
  assert.equal(canManageSettings({
    ...trustedAdmin,
    actor: { ...trustedAdmin.actor, identityStatus: 'pending' },
  }, policy), false);

  const guard = createSettingsAdminRouteGuard('settings', policy);
  let error: unknown = 'not-called';
  guard(
    { method: 'POST', path: '/credentials', user: trustedAdmin } as never,
    {} as never,
    (nextError?: unknown) => { error = nextError; },
  );
  assert.equal(error, undefined);
});
