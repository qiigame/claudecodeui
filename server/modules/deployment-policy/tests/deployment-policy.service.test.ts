import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  createDeploymentPolicyMiddleware,
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  readDeploymentPolicyRequestContext,
  resolveCanonicalPath,
} from '../index.js';

test('product QA readonly profile exposes only read capabilities by default', () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  });

  assert.equal(policy.profile, 'product-qa-readonly');
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.REPO_READ), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PROJECT_READ), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.FILE_READ), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SESSION_READ), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.REPO_WRITE), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.FILE_WRITE), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PLUGIN_USE), false);
  assert.equal(isDeploymentReadOnly(policy), true);
});

test('product QA readonly profile cannot be reopened by any mutation capability alias', () => {
  // Keep this list exhaustive with the policy's mutation boundary.  A future
  // capability added to `MUTATING_CAPABILITIES` should be added here before
  // it can accidentally become writable through an env override.
  const mutationAliases = [
    'repo.write',
    'project.mutate',
    'file.write',
    'worktree.mutate',
    'git.fetch',
    'git.write',
    'shell.exec',
    'terminal.interactive',
    'agent.use',
    'provider.write',
    'mcp.write',
    'plugin.use',
    'plugin.write',
    'browser.use',
    'settings.write',
    'local-filesystem',
    'local-git',
    'local-shell',
  ];
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: mutationAliases.map((name) => `${name}=true`).join(','),
    ...Object.fromEntries(
      mutationAliases.map((name) => [`CLOUDCLI_CAPABILITY_${name.replace(/[.-]/g, '_').toUpperCase()}`, 'true']),
    ),
  });

  for (const capability of mutationAliases) {
    assert.equal(hasDeploymentCapability(policy, capability), false, capability);
  }
  assert.equal(isDeploymentReadOnly(policy), true);
});

test('developer profile exposes local write and execution capabilities', () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
  });

  assert.equal(policy.profile, 'developer');
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.REPO_WRITE), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PROJECT_MUTATE), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.FILE_WRITE), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.WORKTREE_MUTATE), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE), true);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PLUGIN_USE), true);
  assert.equal(isDeploymentReadOnly(policy), false);
});

test('plugin.use alias is a distinct execution capability from plugin.write management', () => {
  const executionOnly = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'platform',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'plugin-use=true,plugin.write=false',
  });
  assert.equal(hasDeploymentCapability(executionOnly, DEPLOYMENT_CAPABILITIES.PLUGIN_USE), true);
  assert.equal(hasDeploymentCapability(executionOnly, DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE), false);

  const readonlyOverride = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'plugin.use=true',
  });
  assert.equal(hasDeploymentCapability(readonlyOverride, DEPLOYMENT_CAPABILITIES.PLUGIN_USE), false);
});

test('policy parser preserves legacy platform mapping and throws on unknown explicit profiles', () => {
  assert.equal(parseDeploymentPolicy({ VITE_IS_PLATFORM: 'true' }).profile, 'platform');
  assert.equal(parseDeploymentPolicy({ VITE_IS_PLATFORM: 'false' }).profile, 'self-hosted');
  assert.throws(() => parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'not-a-profile' }), {
    code: 'INVALID_DEPLOYMENT_PROFILE',
    statusCode: 400,
  });
});

test('DingTalk deployments without an explicit profile fail closed to product QA readonly', () => {
  for (const environment of [
    { CLOUDCLI_DINGTALK_CREDENTIALS_FILE: '/run/secrets/dingtalk.json' },
    { CLOUDCLI_DINGTALK_PUBLIC_ORIGIN: 'https://cloudcli.example.test' },
    { CLOUDCLI_REQUIRE_DINGTALK_AUTH: 'true' },
  ]) {
    const policy = parseDeploymentPolicy(environment);
    assert.equal(policy.profile, 'product-qa-readonly');
    assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.REPO_WRITE), false);
    assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE), false);
  }

  assert.equal(parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DINGTALK_PUBLIC_ORIGIN: 'https://cloudcli.example.test',
  }).profile, 'developer');
});

test('capability overrides normalize aliases and never grant malformed values', () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'repo.write=false,custom_flag=true,ignored=maybe',
    CLOUDCLI_CAPABILITY_SHELL_EXEC: 'off',
    CLOUDCLI_CAPABILITY_SHELL_EXECUTE: 'false',
    CLOUDCLI_CAPABILITY_BROWSER_USE: 'false',
    CLOUDCLI_CAPABILITY_FILE_WRITE: 'false',
  });

  assert.equal(hasDeploymentCapability(policy, 'repo.write'), false);
  assert.equal(hasDeploymentCapability(policy, 'custom-flag'), true);
  assert.equal(hasDeploymentCapability(policy, 'ignored'), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SHELL_EXECUTE), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.BROWSER_USE), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.FILE_WRITE), false);
});

test('read capability environment aliases can explicitly disable optional reads', () => {
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'developer',
    CLOUDCLI_CAPABILITY_BROWSER_READ: 'false',
    CLOUDCLI_CAPABILITY_MEMORY_READ: 'off',
    CLOUDCLI_CAPABILITY_SKILL_READ: '0',
  });

  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.BROWSER_READ), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.MEMORY_READ), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.SKILL_READ), false);
  assert.equal(hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.BROWSER_USE), true);
});

test('middleware parses actor, session, and path context before checking capabilities', async () => {
  const guard = createDeploymentPolicyMiddleware({
    policy: { profile: 'product-qa-readonly', capabilities: { [DEPLOYMENT_CAPABILITIES.SESSION_READ]: true } },
    capability: DEPLOYMENT_CAPABILITIES.SESSION_READ,
    targetPath: (_request, context) => context.targetPath,
  });
  const request = {
    method: 'GET',
    params: { sessionId: 'session-1' },
    query: { path: process.cwd() },
    body: {},
    user: {
      id: 7,
      actor: { actorId: 11, provider: 'dingtalk' },
    },
  } as never;
  let nextError: unknown = 'not-called';

  await new Promise<void>((resolve) => {
    guard(request, {} as never, (error?: unknown) => {
      nextError = error;
      resolve();
    });
  });

  assert.equal(nextError, undefined);
  assert.deepEqual((request as any).deploymentPolicyContext, {
    actor: { userId: 7, actorId: 11, provider: 'dingtalk' },
    sessionId: 'session-1',
    projectPath: null,
    targetPath: process.cwd(),
    canonicalTargetPath: process.cwd(),
  });
});

test('middleware denies missing capability with AppError', () => {
  const guard = createDeploymentPolicyMiddleware({
    policy: { profile: 'product-qa-readonly', capabilities: { [DEPLOYMENT_CAPABILITIES.REPO_READ]: true } },
    capability: DEPLOYMENT_CAPABILITIES.REPO_WRITE,
  });
  let denied: unknown;

  guard({ method: 'POST', params: {}, query: {}, body: {} } as never, {} as never, (error?: unknown) => {
    denied = error;
  });

  assert.ok(denied instanceof AppError);
  assert.equal(denied.code, 'DEPLOYMENT_CAPABILITY_DENIED');
  assert.equal(denied.statusCode, 403);
});

test('middleware captures a function policy once instead of resolving it per request', () => {
  let sourceCalls = 0;
  const guard = createDeploymentPolicyMiddleware({
    policy: () => {
      sourceCalls += 1;
      return parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' });
    },
    capability: DEPLOYMENT_CAPABILITIES.REPO_READ,
  });
  const request = { method: 'GET', params: {}, query: {}, body: {} } as never;
  let firstError: unknown = 'not-called';
  let secondError: unknown = 'not-called';

  guard(request, {} as never, (error?: unknown) => { firstError = error; });
  guard(request, {} as never, (error?: unknown) => { secondError = error; });

  assert.equal(firstError, undefined);
  assert.equal(secondError, undefined);
  assert.equal(sourceCalls, 1);
});

test('canonical path helper resolves symlinks and denies paths outside root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deployment-policy-service-'));
  const insideDirectory = path.join(root, 'inside');
  const outsideDirectory = path.join(root, 'outside');
  await mkdir(insideDirectory);
  await mkdir(outsideDirectory);
  await writeFile(path.join(insideDirectory, 'file.txt'), 'ok');
  await writeFile(path.join(outsideDirectory, 'file.txt'), 'no');
  const link = path.join(root, 'inside-link');
  await symlink(insideDirectory, link, 'dir');

  const canonical = await resolveCanonicalPath(path.join(link, 'file.txt'), { beneath: root });
  assert.equal(canonical, await realpath(path.join(insideDirectory, 'file.txt')));

  await assert.rejects(
    resolveCanonicalPath(path.join(outsideDirectory, 'file.txt'), { beneath: insideDirectory }),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_CANONICAL_ROOT'
      && error.statusCode === 403,
  );
});
