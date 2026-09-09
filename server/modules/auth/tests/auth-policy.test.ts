import assert from 'node:assert/strict';
import test from 'node:test';

import { extractBearerToken, resolveAuthDeploymentMode } from '../auth-policy.js';
import { extractBearerTokenFromQuery } from '@/shared/bearer-token.js';

test('REST Authorization parsing accepts only a single Bearer credential', () => {
  assert.equal(extractBearerToken('Bearer jwt-token'), 'jwt-token');
  assert.equal(extractBearerToken('bearer\tjwt-token'), 'jwt-token');
  assert.equal(extractBearerToken('Bearer jwt-token   '), 'jwt-token');
  assert.equal(extractBearerToken('Basic jwt-token'), null);
  assert.equal(extractBearerToken('Digest username=alice'), null);
  assert.equal(extractBearerToken('Bearer'), null);
  assert.equal(extractBearerToken('Bearer   '), null);
  assert.equal(extractBearerToken('Bearer jwt-token extra'), null);
  assert.equal(extractBearerToken('Bearer jwt-token,other'), null);
  assert.equal(extractBearerToken('Bearer jwt:token'), null);
  assert.equal(extractBearerToken(['Bearer', 'jwt-token']), null);
});

test('query credentials use the same strict token grammar and reject ambiguity', () => {
  assert.equal(extractBearerTokenFromQuery('jwt-token'), 'jwt-token');
  assert.equal(extractBearerTokenFromQuery(' jwt-token '), 'jwt-token');
  assert.equal(extractBearerTokenFromQuery('jwt:token'), null);
  assert.equal(extractBearerTokenFromQuery('jwt-token extra'), null);
  assert.equal(extractBearerTokenFromQuery(''), null);
  assert.equal(extractBearerTokenFromQuery(['first', 'second']), null);
  assert.equal(extractBearerTokenFromQuery({ token: 'jwt-token' }), null);
});

test('ordinary self-hosted deployments retain password authentication', () => {
  const mode = resolveAuthDeploymentMode({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    VITE_IS_PLATFORM: 'false',
  });

  assert.deepEqual(mode, {
    profile: 'developer',
    dingtalkConfigured: false,
    requiresDingTalk: false,
    platformBypass: false,
    passwordLoginEnabled: true,
    mode: 'password',
  });
});

test('legacy platform mode bypasses login only without an SSO declaration', () => {
  const mode = resolveAuthDeploymentMode({ VITE_IS_PLATFORM: 'true' });

  assert.equal(mode.platformBypass, true);
  assert.equal(mode.passwordLoginEnabled, false);
  assert.equal(mode.requiresDingTalk, false);
  assert.equal(mode.mode, 'platform');
});

test('an explicit developer profile is not weakened by a stale platform UI flag', () => {
  const mode = resolveAuthDeploymentMode({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    VITE_IS_PLATFORM: 'true',
  });

  assert.equal(mode.profile, 'developer');
  assert.equal(mode.platformBypass, false);
  assert.equal(mode.passwordLoginEnabled, true);
  assert.equal(mode.mode, 'password');
});

test('an explicit managed profile owns the platform auth decision', () => {
  const mode = resolveAuthDeploymentMode({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'platform',
    VITE_IS_PLATFORM: 'false',
  });

  assert.equal(mode.platformBypass, true);
  assert.equal(mode.passwordLoginEnabled, false);
  assert.equal(mode.mode, 'platform');
});

test('production profile still requires a credential and does not use platform bypass', () => {
  const mode = resolveAuthDeploymentMode({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'production',
    VITE_IS_PLATFORM: 'true',
  });

  assert.equal(mode.profile, 'production');
  assert.equal(mode.platformBypass, false);
  assert.equal(mode.requiresDingTalk, false);
  assert.equal(mode.passwordLoginEnabled, true);
  assert.equal(mode.mode, 'password');
});

test('production profile with DingTalk declaration still requires DingTalk', () => {
  const mode = resolveAuthDeploymentMode({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'production',
    CLOUDCLI_DINGTALK_PUBLIC_ORIGIN: 'https://cloudcli.example.invalid',
  });

  assert.equal(mode.profile, 'production');
  assert.equal(mode.platformBypass, false);
  assert.equal(mode.requiresDingTalk, true);
  assert.equal(mode.passwordLoginEnabled, false);
  assert.equal(mode.mode, 'dingtalk');
});

test('readonly profile requires DingTalk even when the platform UI flag is set', () => {
  const mode = resolveAuthDeploymentMode({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    VITE_IS_PLATFORM: 'true',
  });

  assert.equal(mode.requiresDingTalk, true);
  assert.equal(mode.platformBypass, false);
  assert.equal(mode.passwordLoginEnabled, false);
  assert.equal(mode.mode, 'dingtalk');
});

test('a partial DingTalk environment declaration fails closed', () => {
  const mode = resolveAuthDeploymentMode({
    VITE_IS_PLATFORM: 'true',
    CLOUDCLI_DINGTALK_PUBLIC_ORIGIN: 'https://cloudcli.example.invalid',
  });

  assert.equal(mode.dingtalkConfigured, true);
  assert.equal(mode.requiresDingTalk, true);
  assert.equal(mode.platformBypass, false);
  assert.equal(mode.passwordLoginEnabled, false);
  assert.equal(mode.mode, 'dingtalk');
});

test('explicit DingTalk requirement disables password fallback on a self-hosted profile', () => {
  const mode = resolveAuthDeploymentMode({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'self-hosted',
    CLOUDCLI_REQUIRE_DINGTALK_AUTH: 'yes',
  });

  assert.equal(mode.requiresDingTalk, true);
  assert.equal(mode.platformBypass, false);
  assert.equal(mode.passwordLoginEnabled, false);
  assert.equal(mode.mode, 'dingtalk');
});
