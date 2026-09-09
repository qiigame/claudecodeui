import type { WebSocket } from 'ws';

import {
  registerDesktopNotificationClient,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/services/desktop-notification-clients.service.js';
import {
  DEPLOYMENT_CAPABILITIES,
  hasDeploymentCapability,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

type DesktopNotificationRegisterMessage = {
  type?: unknown;
  kind?: unknown;
  deviceId?: unknown;
  label?: unknown;
  platform?: unknown;
  appVersion?: unknown;
};

function readRequestUserId(request: AuthenticatedWebSocketRequest): number | null {
  const user = request.user;
  const rawUserId = typeof user?.id === 'number' || typeof user?.id === 'string'
    ? user.id
    : typeof user?.userId === 'number' || typeof user?.userId === 'string'
      ? user.userId
      : null;
  const numericUserId = Number(rawUserId);
  return Number.isInteger(numericUserId) && numericUserId > 0 ? numericUserId : null;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export type DesktopNotificationsConnectionOptions = {
  /** Immutable deployment policy supplied by the websocket composition root. */
  deploymentPolicy?: DeploymentPolicy;
};

// Standalone websocket consumers do not have a composition root to inject the
// policy. Capture the trusted process configuration once at module startup so
// an environment mutation after boot cannot reopen endpoint registration.
const standaloneDeploymentPolicy = parseDeploymentPolicy();

function rejectRegistration(ws: WebSocket): void {
  sendJson(ws, {
    type: 'error',
    code: 'DEPLOYMENT_CAPABILITY_DENIED',
    message: 'Desktop notification registration is disabled for this deployment.',
  });
  ws.close(1008, 'Desktop notification registration is disabled');
}

/**
 * Handles the authenticated desktop-notification socket. The first register
 * frame persists a device endpoint, so it is treated as a session metadata
 * write and checked before any database upsert. Product/QA deployments grant
 * `session.write` for personal conversation and notification metadata while
 * still denying code, Git, shell, and provider mutations.
 */
export function handleDesktopNotificationsConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  options: DesktopNotificationsConnectionOptions = {},
): void {
  const deploymentPolicy = options.deploymentPolicy ?? standaloneDeploymentPolicy;
  const userId = readRequestUserId(request);
  if (!userId) {
    ws.close(1008, 'Missing authenticated user');
    return;
  }

  let registered = false;

  ws.on('message', (rawMessage) => {
    const data = parseIncomingJsonObject(rawMessage) as DesktopNotificationRegisterMessage | null;
    if (!data) {
      return;
    }

    const type = typeof data.type === 'string' ? data.type : typeof data.kind === 'string' ? data.kind : '';
    if (type === 'notification_ack') {
      return;
    }

    if (type !== 'register' || registered) {
      return;
    }

    // Registration persists the endpoint and therefore must be checked
    // immediately before validating/upserting the supplied device metadata.
    // Keeping the check here also permits harmless acknowledgement frames on
    // a socket whose deployment does not expose endpoint registration.
    if (
      !hasDeploymentCapability(
        deploymentPolicy,
        DEPLOYMENT_CAPABILITIES.SESSION_WRITE,
      )
    ) {
      // Mark the one-shot registration handshake consumed before closing so a
      // malformed/mock transport that delivers another frame cannot retry the
      // denied operation in a tight loop.
      registered = true;
      rejectRegistration(ws);
      return;
    }

    const deviceId = readOptionalString(data.deviceId);
    if (!deviceId) {
      sendJson(ws, {
        type: 'error',
        code: 'DEVICE_ID_REQUIRED',
        message: 'Desktop notification registration requires deviceId.',
      });
      ws.close(1008, 'Missing deviceId');
      return;
    }

    const device = registerDesktopNotificationClient({
      userId,
      deviceId,
      label: readOptionalString(data.label),
      platform: readOptionalString(data.platform),
      appVersion: readOptionalString(data.appVersion),
      ws,
    });

    if (!device) {
      ws.close(1011, 'Registration failed');
      return;
    }

    registered = true;
    sendJson(ws, {
      type: 'registered',
      deviceId: device.endpoint_id,
      enabled: Boolean(device.enabled),
    });
  });

  ws.on('close', () => {
    unregisterDesktopNotificationClient(ws);
  });

  ws.on('error', () => {
    unregisterDesktopNotificationClient(ws);
  });
}
