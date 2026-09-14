import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// The auth hook is consumed at render time through the module's public API.
import { useAuth } from '@/modules/auth';
import { api } from '@/shared/api';

/** Names accepted by the client when checking a server deployment capability. */
export type DeploymentCapability = string;

/** The server-owned deployment profile and its effective capability map. */
export type DeploymentPolicy = {
  profile: string;
  capabilities: Readonly<Record<string, boolean>>;
  capabilityNames: Readonly<Record<string, string>>;
  /** Optional startup preference for new developer conversations; never grants capabilities. */
  defaultPermissionMode?: 'default' | 'bypassPermissions';
};

/** Loading state exposed to UI components so they can fail closed while policy is unavailable. */
export type DeploymentPolicyStatus = 'loading' | 'ready' | 'error';

/** Read-only deployment capabilities intentionally retained for product, operations and QA users. */
const READ_ONLY_CAPABILITIES = [
  'repo.read',
  'project.read',
  'file.read',
  'session.read',
  // Conversation rows/titles are safe application data writes. They are
  // intentionally allowed in product/QA while code, Git, worktree, and
  // provider configuration writes remain disabled.
  'session.write',
  'worktree.read',
  'git.read',
  'provider.runtime',
  'terminal.readonly',
  'qa.run',
  'mcp.read',
  'plugin.read',
  'browser.read',
  'attachment.upload',
  'chat.use',
  'settings.read',
  'memory.read',
  'skill.read',
] as const;

/**
 * Capabilities safe to expose while the server policy is still loading or has
 * failed.  This deliberately excludes session metadata writes, provider
 * runtime access, uploads, and chat control: those operations must wait for a
 * server-confirmed policy instead of relying on a browser fallback.
 */
const POLICY_BOOTSTRAP_READ_CAPABILITIES = new Set<string>([
  'repo.read',
  'project.read',
  'file.read',
  'session.read',
  'worktree.read',
  'git.read',
  'terminal.readonly',
  'mcp.read',
  'plugin.read',
  'browser.read',
  'settings.read',
  'memory.read',
  'skill.read',
]);

/** Mutating capabilities which must all be absent before the UI is considered read-only. */
const MUTATING_CAPABILITIES = [
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
] as const;

const WRITABLE_PROFILES = new Set([
  'developer',
  'development',
  'self-hosted',
  'test',
]);

const CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  'attachment-upload': 'attachment.upload',
  'browser-control': 'browser.use',
  'browser-read': 'browser.read',
  'browser-use': 'browser.use',
  'chat-use': 'chat.use',
  'file-mutate': 'file.write',
  'file-write': 'file.write',
  'git-fetch': 'git.fetch',
  'git-mutate': 'git.write',
  'git-push': 'git.write',
  'git-write': 'git.write',
  'project-write': 'project.mutate',
  'project-mutate': 'project.mutate',
  'plugin-use': 'plugin.use',
  'plugin-write': 'plugin.write',
  'provider-runtime': 'provider.runtime',
  'provider-write': 'provider.write',
  'qa-run': 'qa.run',
  'repo-read': 'repo.read',
  'repo-mutate': 'repo.write',
  'repo-write': 'repo.write',
  'session-read': 'session.read',
  'session-mutate': 'session.write',
  'session-write': 'session.write',
  'shell-exec': 'shell.exec',
  'shell-execute': 'shell.exec',
  'skill-read': 'skill.read',
  'terminal-readonly': 'terminal.readonly',
  'terminal-interactive': 'terminal.interactive',
  'worktree-write': 'worktree.mutate',
  'worktree-mutate': 'worktree.mutate',
  'local-filesystem': 'local-filesystem',
  'local-git': 'local-git',
  'local-shell': 'local-shell',
};

const normalizeCapability = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  return CAPABILITY_ALIASES[normalized] ?? normalized;
};

const normalizeProfile = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';

const mapCapabilities = (names: readonly string[], enabled = true): Readonly<Record<string, boolean>> =>
  Object.freeze(Object.fromEntries(names.map((name) => [name, enabled])));

const readOnlyFallbackCapabilities = mapCapabilities(READ_ONLY_CAPABILITIES);
const writableFallbackCapabilities = mapCapabilities([
  ...READ_ONLY_CAPABILITIES,
  ...MUTATING_CAPABILITIES,
]);

const readEnvironmentProfile = (): string => {
  const profile = import.meta.env?.VITE_DEPLOYMENT_PROFILE;
  return normalizeProfile(profile);
};

/**
 * Builds may declare a legacy profile for the policy fallback object, but that
 * object is never exposed as writable until the server response is confirmed.
 * Deployment mode is never inferred from a browser-controlled toggle.
 */
function fallbackPolicy(): DeploymentPolicy {
  const configuredProfile = readEnvironmentProfile();
  const profile = configuredProfile || 'product-qa-readonly';
  const capabilities = WRITABLE_PROFILES.has(configuredProfile)
    ? writableFallbackCapabilities
    : readOnlyFallbackCapabilities;
  return {
    profile,
    capabilities,
    capabilityNames: Object.freeze({}),
  };
}

const DEFAULT_POLICY = fallbackPolicy();

const createCapabilityReader = (
  capabilities: Readonly<Record<string, boolean>>,
  status: DeploymentPolicyStatus,
) => {
  const normalizedCapabilities = new Map(
    Object.entries(capabilities).map(([name, enabled]) => [normalizeCapability(name), enabled]),
  );
  return (capability: DeploymentCapability): boolean => {
    const canonical = normalizeCapability(capability);
    if (canonical.length === 0) return false;
    // The initial/error state is intentionally fail-closed.  Keep only data
    // reads visible so a transient policy request failure cannot reopen a
    // mutation or provider execution path from VITE_DEPLOYMENT_PROFILE.
    if (status !== 'ready') return POLICY_BOOTSTRAP_READ_CAPABILITIES.has(canonical);
    return normalizedCapabilities.get(canonical) === true;
  };
};

const isPolicyReadOnly = (policy: DeploymentPolicy, status: DeploymentPolicyStatus): boolean =>
  status !== 'ready'
  || policy.profile === 'product-qa-readonly'
  || !MUTATING_CAPABILITIES.some((name) => policy.capabilities[name] === true);

/** Context value consumed by workspace chrome and action controls. */
export type DeploymentPolicyContextValue = {
  policy: DeploymentPolicy;
  status: DeploymentPolicyStatus;
  error: string | null;
  isReadOnly: boolean;
  can: (capability: DeploymentCapability) => boolean;
  refresh: () => Promise<void>;
};

const createContextValue = (
  policy: DeploymentPolicy,
  status: DeploymentPolicyStatus,
  error: string | null,
  refresh: () => Promise<void>,
): DeploymentPolicyContextValue => ({
  policy,
  status,
  error,
  isReadOnly: isPolicyReadOnly(policy, status),
  can: createCapabilityReader(policy.capabilities, status),
  refresh,
});

const noopRefresh = async (): Promise<void> => undefined;
const DeploymentPolicyContext = createContext<DeploymentPolicyContextValue>(
  createContextValue(DEFAULT_POLICY, 'error', 'Deployment policy provider is unavailable.', noopRefresh),
);

type DeploymentPolicyProviderProps = {
  children: ReactNode;
};

function parsePolicyPayload(payload: unknown): DeploymentPolicy {
  const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const candidate = envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : envelope;
  const profile = normalizeProfile(candidate.profile);
  const rawCapabilities = candidate.capabilities;

  if (!profile || !rawCapabilities || typeof rawCapabilities !== 'object' || Array.isArray(rawCapabilities)) {
    throw new Error('Deployment policy response is malformed.');
  }

  const capabilities: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(rawCapabilities as Record<string, unknown>)) {
    const canonical = normalizeCapability(name);
    if (canonical && typeof enabled === 'boolean') {
      capabilities[canonical] = enabled;
    }
  }

  const rawCapabilityNames = candidate.capabilityNames;
  const capabilityNames: Record<string, string> = {};
  if (rawCapabilityNames && typeof rawCapabilityNames === 'object' && !Array.isArray(rawCapabilityNames)) {
    for (const [name, label] of Object.entries(rawCapabilityNames as Record<string, unknown>)) {
      if (typeof label === 'string') capabilityNames[normalizeCapability(name)] = label;
    }
  }

  return {
    profile,
    capabilities: Object.freeze(capabilities),
    capabilityNames: Object.freeze(capabilityNames),
    // Older servers omit this field. Only an explicit developer deployment
    // can opt into the unrestricted new-chat default; read-only wins even
    // over a contradictory response from a partially upgraded server.
    defaultPermissionMode: profile === 'developer'
      && candidate.defaultPermissionMode === 'bypassPermissions'
      && capabilities['repo.write'] === true
      && capabilities['file.write'] === true
      && capabilities['git.write'] === true
      && capabilities['shell.exec'] === true
      && capabilities['provider.runtime'] === true
      ? 'bypassPermissions'
      : 'default',
  };
}

/**
 * Provides server-authoritative deployment capabilities to all authenticated
 * UI modules. It is mounted below AuthProvider in App.
 */
export function DeploymentPolicyProvider({ children }: DeploymentPolicyProviderProps) {
  const { user, token } = useAuth();
  const userKey = user ? String(user.id ?? user.username) : null;
  // A monotonically increasing request id prevents a late response from a
  // previous DingTalk account from changing the current account's controls.
  const requestGenerationRef = useRef(0);
  // Policy state is kept as one unit so profile, capabilities and status cannot
  // render from different requests during an account switch.
  const [policyState, setPolicyState] = useState<{
    policy: DeploymentPolicy;
    status: DeploymentPolicyStatus;
    error: string | null;
  }>({ policy: DEFAULT_POLICY, status: 'loading', error: null });

  const refresh = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    if (!userKey) {
      setPolicyState({ policy: DEFAULT_POLICY, status: 'loading', error: null });
      return;
    }

    setPolicyState((previous) => ({ ...previous, status: 'loading', error: null }));

    try {
      let response = await api.deploymentPolicy();
      // Older servers expose the same contract at /api/capabilities.
      if (response.status === 404) {
        response = await api.capabilities();
      }
      if (!response.ok) {
        throw new Error(`Deployment policy request failed (${response.status}).`);
      }

      const policy = parsePolicyPayload(await response.json());
      if (generation !== requestGenerationRef.current) return;
      setPolicyState({ policy, status: 'ready', error: null });
    } catch (caughtError) {
      if (generation !== requestGenerationRef.current) return;
      const message = caughtError instanceof Error ? caughtError.message : 'Deployment policy unavailable.';
      // Keep the previous map only when it was already a confirmed policy;
      // initial/unknown state always falls back to the restrictive map.
      setPolicyState({ policy: DEFAULT_POLICY, status: 'error', error: message });
    }
  }, [token, userKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const contextValue = useMemo(
    () => createContextValue(policyState.policy, policyState.status, policyState.error, refresh),
    [policyState.error, policyState.policy, policyState.status, refresh],
  );

  return (
    <DeploymentPolicyContext.Provider value={contextValue}>
      {children}
    </DeploymentPolicyContext.Provider>
  );
}

/** Reads the current deployment policy; absent providers fail closed to read-only defaults. */
export function useDeploymentPolicy(): DeploymentPolicyContextValue {
  return useContext(DeploymentPolicyContext);
}
