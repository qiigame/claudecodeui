import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';
import type { DingTalkActorIdentityInput } from '@/shared/types.js';

import { createDingTalkOAuthService } from '../dingtalk-oauth.service.js';

async function withCredentials(
  run: (credentialsPath: string) => Promise<void>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-dingtalk-oauth-'));
  const credentialsPath = path.join(directory, 'dingtalk-auth.json');
  await writeFile(credentialsPath, JSON.stringify({
    sessionSecret: 's'.repeat(64),
    allowedUsers: ['unionid:union-1'],
    providers: [{
      key: 'comic',
      name: '漫剧团队',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }],
    identities: {
      张三: { badge: '张', gitEmail: 'zhangsan@example.invalid' },
    },
    ...overrides,
  }), { mode: 0o600 });

  try {
    await run(credentialsPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('DingTalk OAuth signs state, exchanges trusted identity, and hands off an existing JWT', async () => {
  await withCredentials(async (credentialsPath) => {
    const actorInputs: unknown[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).includes('userAccessToken')) {
          return new Response(JSON.stringify({ accessToken: 'access-token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          name: '张三',
          openId: 'open-1',
          unionId: 'union-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      now: () => 1_700_000_000,
      randomNonce: () => 'fixed-nonce',
      upsertActor: (input) => {
        actorInputs.push(input);
        return {
          user: { id: 7, username: '张三' },
          actor: {
            actorId: 11,
            userId: 7,
            displayName: '张三',
            badge: '张',
            provider: 'dingtalk',
            providerName: '漫剧团队',
            personId: 'zhangsan',
            identityStatus: 'verified',
          },
        };
      },
      generateToken: (user) => `jwt-for-${user.id}`,
      settingsAdminUserIds: '7',
    });

    const started = service.beginLogin('comic', '/session/session-1');
    const authorizeUrl = new URL(started.authorizeUrl);
    assert.equal(authorizeUrl.hostname, 'login.dingtalk.com');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'client-id');
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      'https://cloudcli.example.invalid/api/auth/dingtalk/callback',
    );

    const completed = await service.completeLogin({
      code: 'oauth-code',
      state: started.state,
      stateCookie: started.state,
    });
    assert.equal(completed.returnTo, '/session/session-1');
    assert.equal(requests.length, 2);
    assert.equal(
      requests[1].init?.headers
        && (requests[1].init.headers as Record<string, string>)['x-acs-dingtalk-access-token'],
      'access-token',
    );
    assert.deepEqual(actorInputs, [{
      providerKey: 'comic',
      providerName: '漫剧团队',
      externalSubject: 'union-1',
      subjectScope: 'global',
      displayName: '张三',
      badge: '张',
      gitEmail: 'zhangsan@example.invalid',
    }]);

    assert.deepEqual(service.consumeSession(completed.session), {
      success: true,
      token: 'jwt-for-7',
      user: {
        id: 7,
        username: '张三',
        actor: {
          actorId: 11,
          userId: 7,
          displayName: '张三',
          badge: '张',
          provider: 'dingtalk',
          providerName: '漫剧团队',
          personId: 'zhangsan',
          identityStatus: 'verified',
        },
        permissions: { manageSettings: true },
      },
      actor: {
        actorId: 11,
        userId: 7,
        displayName: '张三',
        badge: '张',
        provider: 'dingtalk',
        providerName: '漫剧团队',
        personId: 'zhangsan',
        identityStatus: 'verified',
      },
    });
  });
});

test('plain HTTP origin stays disabled without the explicit test-only gate', async () => {
  await withCredentials(async (credentialsPath) => {
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'http://192.168.0.78:3090',
      allowInsecureHttpForTests: false,
      fetch,
      now: () => 1,
      randomNonce: () => 'nonce',
      upsertActor: () => { throw new Error('unused'); },
      generateToken: () => 'unused',
    });

    assert.deepEqual(service.getPublicStatus(), { enabled: false, providers: [] });
    assert.throws(
      () => service.beginLogin('comic', '/'),
      (error: unknown) => error instanceof AppError
        && error.code === 'DINGTALK_PUBLIC_ORIGIN_INVALID',
    );
  });
});

test('managed OAuth requests automatic enrollment after the DingTalk allowlist succeeds', async () => {
  await withCredentials(async (credentialsPath) => {
    const actorInputs: DingTalkActorIdentityInput[] = [];
    let resolverOptions: { required?: boolean; allowAutomaticEnrollment?: boolean } | undefined;
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      deploymentProfile: 'product-qa-readonly',
      fetch: (async (url: string | URL | Request) => String(url).includes('userAccessToken')
        ? new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 })
        : new Response(JSON.stringify({ name: '张三', openId: 'open-1', unionId: 'union-1' }), { status: 200 })) as typeof fetch,
      now: () => 1_700_000_000,
      randomNonce: () => 'fixed-nonce',
      resolveRegistryIdentity: (_input, options) => {
        resolverOptions = options;
        return {
          personId: null,
          displayName: '张三',
          identityStatus: 'pending',
          providerKey: 'comic',
          externalSubject: 'union-1',
          subjectScope: 'global',
          vcsIdentityIds: [],
        };
      },
      upsertActor: (input) => {
        actorInputs.push(input);
        return {
          user: { id: 7, username: '张三' },
          actor: { actorId: 11, userId: 7, displayName: '张三', badge: '张', provider: 'dingtalk', providerName: '漫剧团队' },
        };
      },
      generateToken: () => 'jwt-for-7',
    });
    const started = service.beginLogin('comic', '/');
    await service.completeLogin({ code: 'oauth-code', state: started.state, stateCookie: started.state });
    assert.equal(actorInputs[0].personId, undefined);
    assert.equal(actorInputs[0].identityStatus, 'pending');
    assert.equal(actorInputs[0].gitEmail, undefined);
    assert.deepEqual(resolverOptions, {
      required: true,
      allowAutomaticEnrollment: true,
    });
  });
});

test('managed profile rejects OAuth completion when the registry resolver is omitted', async () => {
  await withCredentials(async (credentialsPath) => {
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      deploymentProfile: 'platform',
      // An older adapter may explicitly pass false, but a managed profile
      // remains registry-bound and must still fail closed before actor upsert
      // when no resolver is supplied.
      requiresDingTalk: false,
      fetch: (async (url: string | URL | Request) => String(url).includes('userAccessToken')
        ? new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 })
        : new Response(JSON.stringify({ name: '张三', openId: 'open-1', unionId: 'union-1' }), { status: 200 })) as typeof fetch,
      now: () => 1_700_000_000,
      randomNonce: () => 'fixed-nonce',
      upsertActor: () => {
        throw new Error('managed OAuth must not reach actor upsert without registry');
      },
      generateToken: () => 'unused',
    });

    const started = service.beginLogin('comic', '/');
    await assert.rejects(
      service.completeLogin({ code: 'oauth-code', state: started.state, stateCookie: started.state }),
      (error: unknown) => error instanceof AppError
        && error.code === 'IDENTITY_REGISTRY_NOT_CONFIGURED',
    );
  });
});

test('managed OAuth rejects a null registry result instead of using name overrides', async () => {
  await withCredentials(async (credentialsPath) => {
    let actorUpserts = 0;
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      deploymentProfile: 'developer',
      requiresDingTalk: true,
      fetch: (async (url: string | URL | Request) => String(url).includes('userAccessToken')
        ? new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 })
        : new Response(JSON.stringify({ name: '张三', openId: 'open-1', unionId: 'union-1' }), { status: 200 })) as typeof fetch,
      now: () => 1_700_000_000,
      randomNonce: () => 'fixed-nonce',
      // A buggy custom adapter returning null must not be interpreted as a
      // legacy/name-only identity in a startup SSO composition.
      resolveRegistryIdentity: () => null,
      upsertActor: () => {
        actorUpserts += 1;
        throw new Error('managed OAuth must not reach actor upsert for null registry result');
      },
      generateToken: () => 'unused',
    });

    const started = service.beginLogin('comic', '/');
    await assert.rejects(
      service.completeLogin({ code: 'oauth-code', state: started.state, stateCookie: started.state }),
      (error: unknown) => error instanceof AppError
        && error.code === 'IDENTITY_REGISTRY_NOT_CONFIGURED',
    );
    assert.equal(actorUpserts, 0);
  });
});

test('provider allowlists are an intersection with the global allowlist', async () => {
  await withCredentials(async (credentialsPath) => {
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      fetch: (async (url: string | URL | Request) => String(url).includes('userAccessToken')
        ? new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 })
        : new Response(JSON.stringify({ name: '张三', openId: 'open-1', unionId: 'union-1' }), { status: 200 })) as typeof fetch,
      now: () => 1_700_000_000,
      randomNonce: () => 'fixed-nonce',
      upsertActor: () => ({
        user: { id: 7, username: '张三' },
        actor: { actorId: 11, userId: 7, displayName: '张三', badge: '张', provider: 'dingtalk', providerName: '漫剧团队' },
      }),
      generateToken: () => 'jwt-for-7',
    });

    // The global list allows union-1, but the selected provider allows only a
    // different subject. The effective policy must deny the login.
    await assert.rejects(
      service.completeLogin((() => {
        const started = service.beginLogin('comic', '/');
        return { code: 'oauth-code', state: started.state, stateCookie: started.state };
      })()),
      (error: unknown) => error instanceof AppError
        && error.code === 'DINGTALK_USER_DENIED'
        && error.statusCode === 403,
    );
  }, {
    providers: [{
      key: 'comic',
      name: '漫剧团队',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      allowedUsers: ['unionid:union-2'],
    }],
  });
});

test('provider-only configuration requires every provider to have an allowlist', async () => {
  await withCredentials(async (credentialsPath) => {
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      fetch,
      now: () => 1,
      randomNonce: () => 'nonce',
      upsertActor: () => { throw new Error('unused'); },
      generateToken: () => 'unused',
    });
    assert.throws(() => service.assertConfiguration(), /Each DingTalk provider must declare an allowlist/);
  }, {
    allowedUsers: undefined,
    providers: [{
      key: 'comic',
      name: '漫剧团队',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }],
  });
});

test('configured identity registry admits a pending actor into the read-only enrollment flow', async () => {
  await withCredentials(async (credentialsPath) => {
    const actorInputs: DingTalkActorIdentityInput[] = [];
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      fetch: (async (url: string | URL | Request) => String(url).includes('userAccessToken')
        ? new Response(JSON.stringify({ accessToken: 'access-token' }), { status: 200 })
        : new Response(JSON.stringify({ name: '张三', openId: 'open-1', unionId: 'union-1' }), { status: 200 })) as typeof fetch,
      now: () => 1_700_000_000,
      randomNonce: () => 'fixed-nonce',
      resolveRegistryIdentity: () => ({
        personId: null,
        displayName: '张三',
        identityStatus: 'pending',
        providerKey: 'comic',
        externalSubject: 'union-1',
        subjectScope: 'global',
        vcsIdentityIds: [],
      }),
      upsertActor: (input) => {
        actorInputs.push(input);
        return {
          user: { id: 7, username: '张三' },
          actor: {
            actorId: 11,
            userId: 7,
            displayName: '张三',
            badge: '张',
            provider: 'dingtalk',
            providerName: '漫剧团队',
            personId: null,
            identityStatus: 'pending',
          },
        };
      },
      generateToken: () => 'pending-jwt',
    });
    const started = service.beginLogin('comic', '/');
    const completed = await service.completeLogin({
      code: 'oauth-code', state: started.state, stateCookie: started.state,
    });
    assert.equal(actorInputs.length, 1);
    assert.equal(actorInputs[0].externalSubject, 'union-1');
    assert.equal(actorInputs[0].identityStatus, 'pending');
    assert.equal(actorInputs[0].personId, undefined);
    assert.equal(service.consumeSession(completed.session).token, 'pending-jwt');
  });
});

test('explicit DingTalk preflight rejects an invalid declared configuration', () => {
  const service = createDingTalkOAuthService({
    credentialsPath: '/missing/credentials.json',
    publicOrigin: 'https://cloudcli.example.test',
    allowInsecureHttpForTests: false,
    fetch,
    now: () => 1,
    randomNonce: () => 'nonce',
    upsertActor: () => { throw new Error('unused'); },
    generateToken: () => 'unused',
  });

  assert.throws(() => service.assertConfiguration());
});

test('partial DingTalk configuration stays request-level fail closed', () => {
  const service = createDingTalkOAuthService({
    publicOrigin: 'https://cloudcli.example.test',
    allowInsecureHttpForTests: false,
    fetch,
    now: () => 1,
    randomNonce: () => 'nonce',
    upsertActor: () => { throw new Error('unused'); },
    generateToken: () => 'unused',
  });

  assert.deepEqual(service.getPublicStatus(), { enabled: false, providers: [] });
  assert.throws(
    () => service.beginLogin('comic', '/'),
    (error: unknown) => error instanceof AppError
      && error.code === 'DINGTALK_NOT_CONFIGURED'
      && error.statusCode === 503,
  );
});

test('DingTalk credentials reject broad permissions, symlink indirection, and non-regular paths', async () => {
  await withCredentials(async (credentialsPath) => {
    const service = createDingTalkOAuthService({
      credentialsPath,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      fetch,
      now: () => 1,
      randomNonce: () => 'nonce',
      upsertActor: () => { throw new Error('unused'); },
      generateToken: () => 'unused',
    });

    await chmod(credentialsPath, 0o640);
    assert.throws(
      () => service.beginLogin('comic', '/'),
      (error: unknown) => error instanceof AppError
        && error.code === 'DINGTALK_CREDENTIAL_PERMISSIONS'
        && error.statusCode === 503,
    );

    const target = path.join(path.dirname(credentialsPath), 'credentials-target.json');
    await writeFile(target, '{}', { mode: 0o600 });
    const link = path.join(path.dirname(credentialsPath), 'credentials-link.json');
    await symlink(target, link);
    const linkedService = createDingTalkOAuthService({
      credentialsPath: link,
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      fetch,
      now: () => 1,
      randomNonce: () => 'nonce',
      upsertActor: () => { throw new Error('unused'); },
      generateToken: () => 'unused',
    });
    assert.throws(
      () => linkedService.beginLogin('comic', '/'),
      (error: unknown) => error instanceof AppError
        && error.code === 'DINGTALK_CREDENTIAL_PERMISSIONS',
    );

    const directoryService = createDingTalkOAuthService({
      credentialsPath: path.dirname(credentialsPath),
      publicOrigin: 'https://cloudcli.example.invalid',
      allowInsecureHttpForTests: false,
      fetch,
      now: () => 1,
      randomNonce: () => 'nonce',
      upsertActor: () => { throw new Error('unused'); },
      generateToken: () => 'unused',
    });
    assert.throws(
      () => directoryService.beginLogin('comic', '/'),
      (error: unknown) => error instanceof AppError
        && error.code === 'DINGTALK_CREDENTIAL_PERMISSIONS',
    );
  });
});
