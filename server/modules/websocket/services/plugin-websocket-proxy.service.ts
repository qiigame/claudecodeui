import { WebSocket } from 'ws';

import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  hasPluginExecutionCapability,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';

export type PluginWebSocketProxyOptions = {
  /**
   * Dynamic execution admission checked before opening the upstream plugin and
   * before forwarding each frame. A long-lived socket must not outlive a
   * revoked DingTalk actor. Exceptions fail closed.
   */
  isExecutionAllowed?: () => boolean;
  /**
   * Marks the caller as a managed execution composition. If set without a
   * revalidator, the proxy fails closed instead of silently using the legacy
   * callback-omitted behavior. Local/developer callers leave this unset.
   */
  requireExecutionAdmission?: boolean;
  /** Optional startup policy supplied by the websocket composition root. */
  deploymentPolicy?: DeploymentPolicy;
};

// The proxy is also imported directly by alternate websocket hosts and tests.
// Capture a trusted process policy once for those callers; never let a later
// process.env mutation turn a read-only deployment into a plugin execution
// host. The production gateway injects its own immutable startup snapshot.
const standaloneDeploymentPolicy = parseDeploymentPolicy();

/**
 * Proxies an authenticated client websocket to a plugin websocket endpoint.
 */
export function handlePluginWsProxy(
  clientWs: WebSocket,
  pathname: string,
  getPluginPort: (pluginName: string) => number | null,
  options: PluginWebSocketProxyOptions = {},
): void {
  const pluginName = pathname.replace('/plugin-ws/', '');
  if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
    clientWs.close(4400, 'Invalid plugin name');
    return;
  }

  const deploymentPolicy = options.deploymentPolicy ?? standaloneDeploymentPolicy;
  // A plugin websocket executes third-party code even when no application
  // frame has been forwarded yet.  Enforce the dedicated execution grant at
  // this lowest-level entry point so alternate/standalone mounts cannot rely
  // on the production gateway's outer guard. `plugin.write` remains accepted
  // by hasPluginExecutionCapability for legacy writable developer installs;
  // product/QA read-only profiles explicitly force both grants off.
  if (deploymentPolicy.profile === 'product-qa-readonly'
    || !hasPluginExecutionCapability(deploymentPolicy)
    || (!hasDeploymentCapability(deploymentPolicy, DEPLOYMENT_CAPABILITIES.PLUGIN_USE)
      && !hasDeploymentCapability(deploymentPolicy, DEPLOYMENT_CAPABILITIES.PLUGIN_WRITE))) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        kind: 'protocol_error',
        code: 'DEPLOYMENT_CAPABILITY_DENIED',
        error: 'Plugin execution is disabled for this deployment.',
      }));
    }
    if (clientWs.readyState !== WebSocket.CLOSING
      && clientWs.readyState !== WebSocket.CLOSED) {
      clientWs.close(1008, 'Plugin execution is disabled');
    }
    return;
  }

  const port = getPluginPort(pluginName);
  if (!port) {
    clientWs.close(4404, 'Plugin not running');
    return;
  }

  // Keep an explicit reference so a client disconnect or an identity revoke
  // can also close an upstream that is still CONNECTING.  Closing only OPEN
  // sockets leaves a half-open outbound connection alive until the OS timeout
  // (and can start a plugin request after its client has gone away).
  let upstream: WebSocket | null = null;
  const closeUpstream = (code?: number, reason?: string): void => {
    const socket = upstream;
    if (!socket || (socket.readyState !== WebSocket.OPEN
      && socket.readyState !== WebSocket.CONNECTING)) {
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      // The socket may transition to CLOSED between the state check and close.
    }
  };

  let executionDenied = false;
  const denyExecution = (): boolean => {
    executionDenied = true;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        kind: 'protocol_error',
        code: 'IDENTITY_ENROLLMENT_REQUIRED',
        error: 'A verified DingTalk project identity is required before using plugins.',
        sessionId: null,
        timestamp: new Date().toISOString(),
      }));
    }
    // `close()` is also needed while the client is still CONNECTING. The
    // upstream may not have emitted `open` yet, but leaving the client socket
    // half-open would let a browser queue frames until that callback runs.
    if (clientWs.readyState !== WebSocket.CLOSING
      && clientWs.readyState !== WebSocket.CLOSED) {
      clientWs.close(1008, 'Verified DingTalk identity required');
    }
    closeUpstream(1008, 'Verified DingTalk identity required');
    return true;
  };
  const rejectRevokedExecution = (): boolean => {
    if (executionDenied) {
      return true;
    }
    if (!options.isExecutionAllowed) {
      return options.requireExecutionAdmission === true ? denyExecution() : false;
    }
    let allowed = false;
    try {
      allowed = options.isExecutionAllowed();
    } catch {
      // Actor registry/database failures are an execution boundary: do not
      // preserve a previously admitted plugin stream on an indeterminate
      // identity result.
      allowed = false;
    }
    if (allowed) {
      return false;
    }

    return denyExecution();
  };

  // Check again after the route-level snapshot admission and immediately
  // before opening the upstream process. This closes the upgrade-to-connect
  // race where an administrator revokes the actor between those callbacks.
  if (rejectRevokedExecution()) {
    return;
  }

  const upstreamSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  upstream = upstreamSocket;

  upstreamSocket.on('open', () => {
    if (rejectRevokedExecution()) {
      closeUpstream(1008, 'Verified DingTalk identity required');
      return;
    }
    console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
  });

  upstreamSocket.on('message', (data, isBinary) => {
    if (rejectRevokedExecution()) {
      closeUpstream(1008, 'Verified DingTalk identity required');
      return;
    }
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (rejectRevokedExecution()) {
      closeUpstream(1008, 'Verified DingTalk identity required');
      return;
    }
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
    }
  });

  upstreamSocket.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  clientWs.on('close', () => {
    closeUpstream();
  });

  upstreamSocket.on('error', (error) => {
    console.error(`[Plugins] WS proxy error for "${pluginName}":`, error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(4502, 'Upstream error');
    }
  });

  clientWs.on('error', () => {
    closeUpstream();
  });
}
