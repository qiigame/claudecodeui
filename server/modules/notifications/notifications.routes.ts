import express, { type RequestHandler } from 'express';

import { notificationChannelEndpointsDb, notificationPreferencesDb } from '@/modules/database/index.js';
import {
  createDeploymentPolicyGuard,
  parseDeploymentPolicy,
  type DeploymentPolicy,
} from '@/modules/deployment-policy/index.js';

/**
 * Options for the notification endpoint router.
 *
 * Notification endpoint registration changes per-user application state, so
 * every write route requires `session.write`.  A production composition root
 * can inject its already-captured guard; standalone/alternate mounts capture
 * a trusted deployment policy when the router is created.
 */
export type NotificationRouterOptions = {
  /** Startup policy, or a resolver evaluated once while constructing the router. */
  deploymentPolicy?: DeploymentPolicy | (() => DeploymentPolicy);
  /** Production composition-root guard; takes precedence over the fallback. */
  capabilityGuard?: (operation: string) => RequestHandler;
};

function captureDeploymentPolicy(
  policy: NotificationRouterOptions['deploymentPolicy'],
): DeploymentPolicy {
  return typeof policy === 'function' ? policy() : policy ?? parseDeploymentPolicy();
}

function readText(value: unknown): string {
  return Array.isArray(value) ? readText(value[0]) : typeof value === 'string' ? value.trim() : '';
}

function sanitizeEndpoint(endpoint: any) {
  return {
    id: endpoint.id,
    channel: endpoint.channel,
    endpointId: endpoint.endpoint_id,
    label: endpoint.label,
    metadata: notificationChannelEndpointsDb.parseMetadata(endpoint.metadata_json),
    enabled: Boolean(endpoint.enabled),
    lastSeenAt: endpoint.last_seen_at,
    createdAt: endpoint.created_at,
    updatedAt: endpoint.updated_at,
  };
}

function readUserId(req: express.Request): number {
  const userId = Number((req as any).user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Authenticated user is missing');
  }
  return userId;
}

function updateChannelPreference(userId: number, channel: string): unknown {
  const currentPrefs = notificationPreferencesDb.getPreferences(userId);
  const hasEnabledEndpoint = notificationChannelEndpointsDb.getEnabledEndpoints(userId, channel).length > 0;
  return notificationPreferencesDb.updatePreferences(userId, {
    ...currentPrefs,
    channels: { ...currentPrefs.channels, [channel]: hasEnabledEndpoint },
  });
}

/** Builds the authenticated notification endpoint router. */
export function createNotificationsRouter(
  options: NotificationRouterOptions = {},
): express.Router {
  const router = express.Router();
  // Capture this once so a standalone mount cannot change its authorization
  // posture by mutating process.env after startup.  The injected production
  // guard already closes over the same startup snapshot as the other routes.
  const sessionWriteGuard = options.capabilityGuard
    ? options.capabilityGuard('session.write')
    : createDeploymentPolicyGuard({
      policy: captureDeploymentPolicy(options.deploymentPolicy),
      capability: 'session.write',
    });

  router.get('/endpoints', (req, res) => {
  try {
    const channel = readText(req.query.channel);
    if (!channel) {
      return res.status(400).json({ error: 'channel is required' });
    }

    const userId = readUserId(req);
    const endpoints = notificationChannelEndpointsDb
      .getEndpoints(userId, channel)
      .map(sanitizeEndpoint);
    return res.json({ success: true, endpoints });
  } catch (error) {
    console.error('Error fetching notification endpoints:', error);
    return res.status(500).json({ error: 'Failed to fetch notification endpoints' });
  }
  });

  router.post('/endpoints/current', sessionWriteGuard, (req, res) => {
  try {
    const { channel, endpointId, label, metadata = {}, enabled = true } = req.body || {};
    const normalizedChannel = readText(channel);
    const normalizedEndpointId = readText(endpointId);
    if (!normalizedChannel || !normalizedEndpointId) {
      return res.status(400).json({ error: 'channel and endpointId are required' });
    }

    const userId = readUserId(req);
    const endpoint = notificationChannelEndpointsDb.upsertEndpoint({
      userId,
      channel: normalizedChannel,
      endpointId: normalizedEndpointId,
      label,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      enabled: enabled !== false,
    });

    const preferences = updateChannelPreference(userId, normalizedChannel);
    return res.json({ success: true, endpoint: sanitizeEndpoint(endpoint), preferences });
  } catch (error) {
    console.error('Error registering notification endpoint:', error);
    return res.status(500).json({ error: 'Failed to register notification endpoint' });
  }
  });

  router.patch('/endpoints/:channel/:endpointId', sessionWriteGuard, (req, res) => {
  try {
    const channel = readText(req.params.channel);
    const endpointId = readText(req.params.endpointId);
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const userId = readUserId(req);
    const updated = notificationChannelEndpointsDb.setEndpointEnabled(userId, channel, endpointId, enabled);
    if (!updated) {
      return res.status(404).json({ error: 'Notification endpoint not found' });
    }

    const endpoint = notificationChannelEndpointsDb.getEndpoint(userId, channel, endpointId);
    const preferences = updateChannelPreference(userId, channel);
    return res.json({ success: true, endpoint: endpoint ? sanitizeEndpoint(endpoint) : null, preferences });
  } catch (error) {
    console.error('Error updating notification endpoint:', error);
    return res.status(500).json({ error: 'Failed to update notification endpoint' });
  }
  });

  router.delete('/endpoints/:channel/:endpointId', sessionWriteGuard, (req, res) => {
  try {
    const channel = readText(req.params.channel);
    const endpointId = readText(req.params.endpointId);
    const userId = readUserId(req);
    const removed = notificationChannelEndpointsDb.removeEndpoint(userId, channel, endpointId);
    if (!removed) {
      return res.status(404).json({ error: 'Notification endpoint not found' });
    }

    const preferences = updateChannelPreference(userId, channel);
    return res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error removing notification endpoint:', error);
    return res.status(500).json({ error: 'Failed to remove notification endpoint' });
  }
  });

  return router;
}

// Singular alias mirrors the surrounding feature-module naming convention;
// keep both names source-compatible for standalone embedders.
export const createNotificationRouter = createNotificationsRouter;

const router = createNotificationsRouter();

export default router;
