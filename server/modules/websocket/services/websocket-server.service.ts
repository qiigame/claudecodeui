import type { Server as HttpServer } from 'node:http';

import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { collaborationService } from '@/modules/collaboration/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import {
  hasVerifiedDingTalkActor,
  verifyWebSocketClient,
} from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import {
  hasPluginExecutionCapability,
  parseDeploymentPolicy,
  type DeploymentPolicy,
  type DeploymentProfile,
} from '@/modules/deployment-policy/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { AppError, readAuthenticatedWebSocketUserId } from '@/shared/utils.js';

type WebSocketServerDependencies = {
  /** Startup-resolved policy shared by chat and shell boundaries. */
  deploymentPolicy?: DeploymentPolicy;
  /**
   * Managed SSO authentication switch. It requires an allowlisted DingTalk
   * principal but does not make project-person mapping a chat permission.
   */
  requireDingTalkActor?: boolean;
  /**
   * Optional stronger chat execution switch for deployments that explicitly
   * require verified project-person attribution.
   */
  requireVerifiedDingTalkActor?: boolean;
  /** Optional test/host override for dynamic DingTalk actor revalidation. */
  isActorVerified?: (userId: string | number) => boolean;
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

/**
 * Policy candidates accepted by the websocket composition boundary.
 *
 * The application root should provide `deploymentPolicy`.  The two nested
 * fields are retained for older embedders that composed chat and shell
 * independently; they are only consulted when the top-level snapshot is
 * absent, and therefore can never override the production snapshot.
 */
export type WebSocketDeploymentPolicyCandidates = {
  deploymentPolicy?: DeploymentPolicy;
  chat?: {
    deploymentPolicy?: DeploymentPolicy;
  };
  shell?: {
    deploymentPolicy?: DeploymentPolicy;
  };
};

const KNOWN_DEPLOYMENT_PROFILES: ReadonlySet<DeploymentProfile> = new Set([
  'product-qa-readonly',
  'developer',
  'development',
  'platform',
  'production',
  'self-hosted',
  'test',
]);

function hasValidDeploymentPolicyShape(value: unknown): value is DeploymentPolicy {
  try {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as {
      profile?: unknown;
      capabilities?: unknown;
    };
    if (typeof candidate.profile !== 'string'
      || !KNOWN_DEPLOYMENT_PROFILES.has(candidate.profile as DeploymentProfile)
      || !candidate.capabilities
      || typeof candidate.capabilities !== 'object'
      || Array.isArray(candidate.capabilities)) {
      return false;
    }

    return Object.values(candidate.capabilities as Record<string, unknown>)
      .every((enabled) => typeof enabled === 'boolean');
  } catch {
    // A malformed/proxied policy is still a configuration failure.  Do not
    // let a getter exception escape as an accidental writable fallback.
    return false;
  }
}

function deploymentPoliciesMatch(left: DeploymentPolicy, right: DeploymentPolicy): boolean {
  if (left.profile !== right.profile) {
    return false;
  }

  try {
    const capabilityNames = new Set([
      ...Object.keys(left.capabilities),
      ...Object.keys(right.capabilities),
    ]);
    return [...capabilityNames].every((name) =>
      (left.capabilities[name] === true) === (right.capabilities[name] === true));
  } catch {
    return false;
  }
}

function snapshotWebSocketDeploymentPolicy(policy: DeploymentPolicy): DeploymentPolicy {
  // The composition root owns the policy, but nested/legacy callers may hand
  // us a mutable object.  Copy and freeze the exact snapshot routed to every
  // websocket transport so a later caller mutation cannot change authorization.
  try {
    return Object.freeze({
      profile: policy.profile,
      capabilities: Object.freeze({ ...policy.capabilities }),
    });
  } catch {
    throw deploymentPolicyConflictError();
  }
}

function deploymentPolicyConflictError(): AppError {
  return new AppError(
    'Conflicting deployment policies were supplied to the websocket gateway.',
    {
      code: 'DEPLOYMENT_POLICY_CONFLICT',
      statusCode: 500,
      details: { boundary: 'websocket-gateway' },
    },
  );
}

/**
 * Resolves one immutable policy for every websocket transport.
 *
 * A top-level composition-root snapshot is authoritative.  When that field
 * is omitted for a legacy host, chat and shell snapshots must agree; silently
 * preferring one would let a writable nested policy reopen a stricter route.
 * A malformed or conflicting legacy configuration fails during construction,
 * before authentication or any provider/PTY/plugin side effect is reachable.
 */
export function resolveWebSocketDeploymentPolicy(
  candidates: WebSocketDeploymentPolicyCandidates = {},
): DeploymentPolicy {
  if (candidates.deploymentPolicy !== undefined) {
    if (!hasValidDeploymentPolicyShape(candidates.deploymentPolicy)) {
      throw deploymentPolicyConflictError();
    }
    return snapshotWebSocketDeploymentPolicy(candidates.deploymentPolicy);
  }

  const readNestedPolicy = (source: unknown): DeploymentPolicy | undefined => {
    if (source === undefined || source === null) {
      return undefined;
    }
    if (typeof source !== 'object' || Array.isArray(source)) {
      throw deploymentPolicyConflictError();
    }
    try {
      return (source as { deploymentPolicy?: DeploymentPolicy }).deploymentPolicy;
    } catch {
      throw deploymentPolicyConflictError();
    }
  };
  const nested = [
    readNestedPolicy(candidates.chat),
    readNestedPolicy(candidates.shell),
  ].filter((policy): policy is DeploymentPolicy => policy !== undefined);

  if (nested.some((policy) => !hasValidDeploymentPolicyShape(policy))) {
    throw deploymentPolicyConflictError();
  }

  if (nested.length > 1 && !deploymentPoliciesMatch(nested[0], nested[1])) {
    throw deploymentPolicyConflictError();
  }

  return snapshotWebSocketDeploymentPolicy(nested[0] ?? parseDeploymentPolicy());
}

/**
 * Used by this module's websocket gateway to keep active transports alive and
 * close half-open connections so their route-specific clients can reconnect.
 */
export function attachWebSocketHeartbeat(
  ws: WebSocket,
  intervalMs = 30_000,
  scheduler = {
    setInterval,
    clearInterval,
  },
): () => void {
  let isAlive = true;
  let stopped = false;

  const markAlive = () => {
    isAlive = true;
  };

  const stopHeartbeat = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    scheduler.clearInterval(heartbeat);
    ws.off('pong', markAlive);
    ws.off('close', stopHeartbeat);
    ws.off('error', stopHeartbeat);
  };

  ws.on('pong', markAlive);
  ws.on('close', stopHeartbeat);
  ws.on('error', stopHeartbeat);

  const heartbeat = scheduler.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // A socket that did not answer the previous ping is half-open from the
    // server's perspective. Terminating it emits close and lets clients resume.
    if (!isAlive) {
      stopHeartbeat();
      ws.terminate();
      return;
    }

    isAlive = false;
    try {
      ws.ping();
    } catch {
      stopHeartbeat();
      ws.terminate();
    }
  }, intervalMs);

  return stopHeartbeat;
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes. Exported through the websocket module for server startup.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  // Resolve once at gateway startup and pass the same immutable policy to all
  // transports. The helper keeps the production snapshot authoritative and
  // rejects conflicting legacy chat/shell snapshots instead of selecting one
  // by object order.
  const deploymentPolicy = resolveWebSocketDeploymentPolicy({
    deploymentPolicy: dependencies.deploymentPolicy,
    chat: dependencies.chat,
    shell: dependencies.shell,
  });
  // DingTalk authentication is the transport boundary. Project-person
  // verification remains a stronger gate only for Shell/plugin/commit paths;
  // ordinary chat stays usable while automatic attribution is pending.
  const managedActorGate = [
    dependencies.requireDingTalkActor,
    dependencies.requireVerifiedDingTalkActor,
    dependencies.verifyClient.requireDingTalkActor,
    dependencies.verifyClient.requireVerifiedDingTalkActor,
    // Legacy hosts sometimes put the SSO switch only on the route-specific
    // dependency object.  Include those declarations before spreading the
    // nested objects below; otherwise the gateway's default `false` would
    // silently erase a stricter chat/shell execution boundary.
    dependencies.chat.requireDingTalkActor,
    dependencies.chat.requireVerifiedDingTalkActor,
    dependencies.shell.requireDingTalkActor,
    dependencies.shell.requireVerifiedDingTalkActor,
  ].some((value) => value === true);
  // The product/QA profile is intrinsically the managed DingTalk deployment
  // profile. Derive the gate here as a last-resort fail-closed default for an
  // alternate composition root that supplied the policy but forgot the auth
  // switch; local developer profiles remain unaffected.
  const effectiveManagedActorGate = managedActorGate
    || deploymentPolicy.profile === 'product-qa-readonly';
  const requireDingTalkActor = effectiveManagedActorGate;
  const requireVerifiedExecutionActor = effectiveManagedActorGate;
  const requireVerifiedChatActor = dependencies.requireVerifiedDingTalkActor === true
    || dependencies.chat.requireVerifiedDingTalkActor === true;
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, {
      ...dependencies.verifyClient,
      requireDingTalkActor,
      requireVerifiedDingTalkActor: false,
    })),
  });

  wss.on('connection', (ws, request) => {
    attachWebSocketHeartbeat(ws);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      handleShellConnection(
        ws,
        {
          ...dependencies.shell,
          deploymentPolicy,
          requireVerifiedDingTalkActor: requireVerifiedExecutionActor,
          isActorVerified: dependencies.isActorVerified ?? dependencies.shell.isActorVerified,
        },
        incomingRequest,
      );
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(
        ws,
        incomingRequest,
        {
          ...dependencies.chat,
          deploymentPolicy,
          requireDingTalkActor,
          requireVerifiedDingTalkActor: requireVerifiedChatActor,
          isActorVerified: dependencies.isActorVerified ?? dependencies.chat.isActorVerified,
        },
      );
      return;
    }

    if (pathname === '/desktop-notifications') {
      handleDesktopNotificationsConnection(ws, incomingRequest, {
        deploymentPolicy,
      });
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      // A plugin websocket is an execution transport, not a read API. Keep
      // pending/ambiguous DingTalk actors on the authenticated socket so the
      // UI can show enrollment state, but never proxy their frames upstream.
      const pluginExecutionDisabled = deploymentPolicy.profile === 'product-qa-readonly'
        || !hasPluginExecutionCapability(deploymentPolicy);
      if (pluginExecutionDisabled) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            kind: 'protocol_error',
            code: 'DEPLOYMENT_CAPABILITY_DENIED',
            error: 'Plugin execution is disabled for this deployment.',
          }));
          ws.close(1008, 'Plugin execution is disabled');
        }
        return;
      }
      if (requireVerifiedExecutionActor && !hasVerifiedDingTalkActor(incomingRequest.user)) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            kind: 'protocol_error',
            code: 'IDENTITY_ENROLLMENT_REQUIRED',
            error: 'A verified DingTalk project identity is required before using plugins.',
            sessionId: null,
            timestamp: new Date().toISOString(),
          }));
          ws.close(1008, 'Verified DingTalk identity required');
        }
        return;
      }
      const pluginActorVerification = requireVerifiedExecutionActor
        ? (() => {
          const userId = readAuthenticatedWebSocketUserId(incomingRequest);
          return () => {
            if (userId === null) {
              return false;
            }
            try {
              if (dependencies.isActorVerified) {
                return dependencies.isActorVerified(userId);
              }
              collaborationService.assertActorCanWrite(userId, { requireRegistry: true });
              return true;
            } catch {
              return false;
            }
          };
        })()
        : undefined;
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort, {
        deploymentPolicy,
        isExecutionAllowed: pluginActorVerification,
        requireExecutionAdmission: requireVerifiedExecutionActor,
      });
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
