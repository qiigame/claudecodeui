import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import {
  DEPLOYMENT_CAPABILITIES,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(
  providers: IProvider[],
  deploymentPolicy: DeploymentPolicy | null = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'developer' }),
) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
    deploymentPolicy: deploymentPolicy ?? undefined,
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('read-only runtime permits abort but rejects approving a tool mutation', async () => {
  const decisions: unknown[][] = [];
  let abortCalls = 0;
  const runtime = createRuntime({
    async abort(sessionId) {
      abortCalls += 1;
      assert.equal(sessionId, 'readonly-session');
      return true;
    },
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending: () => [],
    },
  });
  const service = createService([
    createProvider('claude', runtime),
  ], parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  }));

  assert.equal(await service.abort('claude', 'readonly-session'), true);
  assert.equal(abortCalls, 1);

  // A denial is safe and is still forwarded so a pending request can settle.
  service.resolveToolApproval('readonly-denial', { allow: false });
  assert.deepEqual(decisions, [['readonly-denial', { allow: false }]]);

  assert.throws(
    () => service.resolveToolApproval('readonly-approval', { allow: true }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DEPLOYMENT_CAPABILITY_DENIED',
  );
  assert.deepEqual(decisions, [['readonly-denial', { allow: false }]]);
});

test('runtime control helpers fail closed without a startup policy', async () => {
  const runtime = createRuntime({
    async abort() {
      throw new Error('abort must not run');
    },
  });
  const service = createService([createProvider('claude', runtime)], null);

  assert.equal(service.hasRuntime('claude'), false);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), []);
  await assert.rejects(
    () => service.abort('claude', 'session-1'),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DEPLOYMENT_POLICY_REQUIRED',
  );
  assert.throws(
    () => service.resolveToolApproval('request-1', { allow: false }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DEPLOYMENT_POLICY_REQUIRED',
  );
});

test('read-only policy forces provider options into the immutable read-only mode', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const runtime = createRuntime({
    async run(_command, options) {
      receivedOptions = options;
      return 'readonly-complete';
    },
  });
  const service = createService([
    createProvider('claude', runtime),
  ], parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  }));
  const originalOptions = {
    deploymentReadOnly: false,
    permissionMode: 'bypassPermissions',
    skipPermissions: true,
    bypassPermissions: true,
    allowDangerous: true,
    toolsSettings: {
      allowedTools: ['Bash', 'Read'],
      skipPermissions: true,
    },
    executionEnvironment: {
      CLOUDCLI_ACTOR_ID: 'actor-1',
      GITHUB_TOKEN: 'must-not-cross-boundary',
      CUSTOM_SECRET: 'must-not-cross-boundary',
    },
  };

  assert.equal(
    await service.run('claude', 'inspect', originalOptions, { send() {} }),
    'readonly-complete',
  );
  assert.deepEqual(receivedOptions, {
    ...originalOptions,
    deploymentReadOnly: true,
    permissionMode: 'plan',
    skipPermissions: false,
    bypassPermissions: false,
    allowDangerous: false,
    toolsSettings: {
      allowedTools: ['Bash', 'Read'],
      skipPermissions: false,
    },
    executionEnvironment: {
      CLOUDCLI_ACTOR_ID: 'actor-1',
    },
  });
  // The dispatcher must not mutate an options object retained by its caller.
  assert.equal(originalOptions.deploymentReadOnly, false);
  assert.equal((originalOptions.toolsSettings as Record<string, unknown>).skipPermissions, true);
});

test('read-only policy cannot be bypassed by a caller-supplied false marker', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const runtime = createRuntime({
    async run(_command, options) {
      receivedOptions = options;
      return undefined;
    },
  });
  const service = createService([
    createProvider('claude', runtime),
  ], parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  }));

  await service.run('claude', 'inspect', { deploymentReadOnly: false }, { send() {} });

  assert.equal(receivedOptions?.deploymentReadOnly, true);
  assert.equal(receivedOptions?.permissionMode, 'plan');
});

test('read-only policy rejects providers without a server-enforced safe runtime', async () => {
  let runtimeCalls = 0;
  const cursorRuntime = createRuntime({
    async run() {
      runtimeCalls += 1;
      return undefined;
    },
  });
  const service = createService([
    createProvider('cursor', cursorRuntime),
  ], parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
  }));

  await assert.rejects(
    () => service.run('cursor', 'must-not-run', {
      deploymentReadOnly: false,
      permissionMode: 'bypassPermissions',
    }, { send() {} }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PROVIDER_READ_ONLY_UNSUPPORTED',
  );
  assert.equal(runtimeCalls, 0);
});

test('read-only policy rejects an unknown provider before resolving its runtime', async () => {
  let providerLookupCalls = 0;
  const service = createProviderRuntimeService({
    deploymentPolicy: parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    }),
    resolveProvider() {
      providerLookupCalls += 1;
      throw new Error('unknown provider lookup must not run');
    },
  });

  await assert.rejects(
    () => service.run('future-provider' as LLMProvider, 'must-not-run', {}, { send() {} }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PROVIDER_READ_ONLY_UNSUPPORTED',
  );
  assert.equal(providerLookupCalls, 0);
});

test('runtime service fails closed when no startup deployment policy was injected', async () => {
  let providerLookupCalls = 0;
  const service = createProviderRuntimeService({
    resolveProvider() {
      providerLookupCalls += 1;
      throw new Error('provider lookup must not run');
    },
  });

  await assert.rejects(
    () => service.run('claude', 'must-not-run', {}, { send() {} }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DEPLOYMENT_POLICY_REQUIRED',
  );
  assert.equal(providerLookupCalls, 0);

  const runner = service.getRunner('claude');
  await assert.rejects(
    () => runner('must-not-run', {}, { send() {} }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DEPLOYMENT_POLICY_REQUIRED',
  );
});

test('runtime service rejects a startup policy without provider runtime capability', async () => {
  const policy = {
    ...parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'developer' }),
    capabilities: {
      [DEPLOYMENT_CAPABILITIES.SESSION_READ]: true,
    },
  };
  let providerLookupCalls = 0;
  const service = createProviderRuntimeService({
    deploymentPolicy: policy,
    resolveProvider() {
      providerLookupCalls += 1;
      throw new Error('provider lookup must not run');
    },
  });

  await assert.rejects(
    () => service.run('claude', 'must-not-run', {}, { send() {} }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DEPLOYMENT_CAPABILITY_DENIED',
  );
  assert.equal(providerLookupCalls, 0);
});

test('developer policy preserves caller runtime options', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const runtime = createRuntime({
    async run(_command, options) {
      receivedOptions = options;
      return undefined;
    },
  });
  const options = {
    deploymentReadOnly: false,
    permissionMode: 'bypassPermissions',
    skipPermissions: true,
    executionEnvironment: { CUSTOM_FLAG: 'keep-me' },
  };
  const service = createService([createProvider('claude', runtime)]);

  await service.run('claude', 'developer-run', options, { send() {} });

  assert.strictEqual(receivedOptions, options);
});
