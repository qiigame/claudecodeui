import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  isDeploymentReadOnly,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { AppError, filterExecutionEnvironmentForReadOnly } from '@/shared/utils.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  /** Immutable deployment policy captured by the application composition root. */
  deploymentPolicy?: DeploymentPolicy;
};

// Claude and Codex are the only adapters with a server-enforced read-only
// contract. Cursor and OpenCode deliberately remain unavailable in a
// product/QA deployment even if a future adapter accidentally ignores the
// `deploymentReadOnly` marker supplied below.
const READ_ONLY_SUPPORTED_PROVIDERS = new Set<LLMProvider>(['claude', 'codex']);

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
};

/**
 * Clone the policy at service construction so a caller cannot mutate the
 * composition-root snapshot after provider runners have been handed out.
 * `undefined` is intentionally preserved: an uncomposed service must reject
 * execution rather than infer a writable profile from request data.
 */
function snapshotDeploymentPolicy(
  policy: DeploymentPolicy | undefined,
): DeploymentPolicy | undefined {
  if (!policy || typeof policy !== 'object') {
    return undefined;
  }

  const capabilities = policy.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return undefined;
  }

  return Object.freeze({
    profile: policy.profile,
    capabilities: Object.freeze({ ...capabilities }),
  });
}

/** Stable service-level error for an uncomposed runtime dispatcher. */
function deploymentPolicyRequiredError(): AppError {
  return new AppError(
    'Provider runtime requires an explicit deployment policy.',
    {
      code: 'DEPLOYMENT_POLICY_REQUIRED',
      statusCode: 503,
    },
  );
}

/** Stable service-level error when the startup policy disables live providers. */
function providerRuntimeDisabledError(policy: DeploymentPolicy): AppError {
  return new AppError(
    'Provider runtime access is disabled for this deployment.',
    {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
      statusCode: 403,
      details: {
        profile: policy.profile,
        capability: DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
      },
    },
  );
}

/** Stable error for a provider that cannot prove a readonly execution path. */
function providerReadOnlyUnsupportedError(providerName: string): AppError {
  return new AppError(
    `Provider "${providerName}" does not expose a safe read-only runtime in this deployment.`,
    {
      code: 'PROVIDER_READ_ONLY_UNSUPPORTED',
      statusCode: 403,
      details: { provider: providerName },
    },
  );
}

/** Stable error for a client trying to approve a mutation in read-only mode. */
function providerApprovalDeniedError(policy: DeploymentPolicy): AppError {
  return new AppError(
    'Tool approvals that could execute mutations are disabled for the read-only deployment.',
    {
      code: 'DEPLOYMENT_CAPABILITY_DENIED',
      statusCode: 403,
      details: {
        profile: policy.profile,
        capability: DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME,
        operation: 'provider.permission.allow',
      },
    },
  );
}

/**
 * Enforces the deployment boundary before provider resolution or any runtime
 * adapter code runs. This is deliberately a service-level check in addition
 * to HTTP/WebSocket guards so scheduled, embedded, and future callers cannot
 * launch a provider without the startup policy.
 */
function assertRuntimeExecutionAllowed(
  policy: DeploymentPolicy | undefined,
): asserts policy is DeploymentPolicy {
  if (!policy) {
    throw deploymentPolicyRequiredError();
  }
  if (!hasDeploymentCapability(policy, DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME)) {
    throw providerRuntimeDisabledError(policy);
  }
}

/**
 * Applies the server-owned readonly runtime contract without mutating the
 * caller's options object. Provider adapters still perform their own detailed
 * sandbox/config filtering; this outer guard ensures every adapter sees the
 * immutable readonly marker and cannot be reopened by a client-supplied mode.
 */
function normalizeRuntimeOptions(
  policy: DeploymentPolicy,
  options: AnyRecord,
): AnyRecord {
  if (!isDeploymentReadOnly(policy)) {
    return options;
  }

  const source = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};
  const normalized: AnyRecord = {
    ...source,
    deploymentReadOnly: true,
    permissionMode: 'plan',
    skipPermissions: false,
    bypassPermissions: false,
    allowDangerous: false,
  };

  // Do not pass arbitrary execution attribution/credential values to a
  // readonly adapter. The provider-specific child-environment filter remains
  // the final defense, but filtering here also protects future adapters.
  normalized.executionEnvironment = filterExecutionEnvironmentForReadOnly(
    source.executionEnvironment,
  );

  if (source.toolsSettings && typeof source.toolsSettings === 'object'
    && !Array.isArray(source.toolsSettings)) {
    normalized.toolsSettings = {
      ...source.toolsSettings,
      skipPermissions: false,
    };
  }

  return normalized;
}

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry. Production
 * callers must inject the startup deployment policy; an omitted policy is a
 * deliberate fail-closed configuration for direct/embedded callers.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const deploymentPolicy = snapshotDeploymentPolicy(dependencies.deploymentPolicy);

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = async (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    assertRuntimeExecutionAllowed(deploymentPolicy);
    if (isDeploymentReadOnly(deploymentPolicy)
      && !READ_ONLY_SUPPORTED_PROVIDERS.has(providerName)) {
      throw providerReadOnlyUnsupportedError(providerName);
    }
    const provider = dependencies.resolveProvider(providerName);
    if (isDeploymentReadOnly(deploymentPolicy)
      && !READ_ONLY_SUPPORTED_PROVIDERS.has(provider.id)) {
      throw providerReadOnlyUnsupportedError(provider.id);
    }
    if (!provider.runtime || typeof provider.runtime.run !== 'function') {
      throw new AppError(`Provider "${providerName}" does not expose a runtime.`, {
        code: 'PROVIDER_RUNTIME_UNAVAILABLE',
        statusCode: 503,
      });
    }
    return provider.runtime.run(
      command,
      normalizeRuntimeOptions(deploymentPolicy, options),
      writer,
      createRuntimeContext(provider),
    );
  };

  return {
    run,

    hasRuntime(providerName: string): boolean {
      if (!deploymentPolicy
        || !hasDeploymentCapability(deploymentPolicy, DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME)) {
        return false;
      }
      try {
        const provider = dependencies.resolveProvider(providerName);
        return Boolean(
          provider.runtime
          && typeof provider.runtime.run === 'function'
          && (!isDeploymentReadOnly(deploymentPolicy)
            || READ_ONLY_SUPPORTED_PROVIDERS.has(provider.id)),
        );
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      // Aborting is a safety control, so it remains available in a read-only
      // deployment for any already-running provider. It still requires the
      // startup runtime capability and may not rely on an uncomposed service.
      assertRuntimeExecutionAllowed(deploymentPolicy);
      const provider = dependencies.resolveProvider(providerName);
      if (!provider.runtime || typeof provider.runtime.abort !== 'function') {
        throw new AppError(`Provider "${providerName}" does not expose an abort operation.`, {
          code: 'PROVIDER_RUNTIME_UNAVAILABLE',
          statusCode: 503,
        });
      }
      return Boolean(await provider.runtime.abort(sessionId));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      assertRuntimeExecutionAllowed(deploymentPolicy);
      if (isDeploymentReadOnly(deploymentPolicy) && decision.allow) {
        throw providerApprovalDeniedError(deploymentPolicy);
      }
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      if (!deploymentPolicy
        || !hasDeploymentCapability(deploymentPolicy, DEPLOYMENT_CAPABILITIES.PROVIDER_RUNTIME)) {
        return [];
      }
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

// The legacy singleton is still exported for embedders, but it captures the
// trusted process policy exactly once at module startup. The server composition
// root creates its own instance after parsing the same snapshot explicitly.
export const providerRuntimeService = createProviderRuntimeService({
  deploymentPolicy: parseDeploymentPolicy(),
});
