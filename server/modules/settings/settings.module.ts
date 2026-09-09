import {
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
} from '@/modules/database/index.js';
import {
  createNotificationEvent,
  getPublicKey,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import type { DeploymentPolicySource } from '@/modules/deployment-policy/index.js';

import { createSettingsRouter } from './settings.routes.js';
import { createSettingsService } from './settings.service.js';

const settingsService = createSettingsService({
  apiKeys: {
    list: (userId) => apiKeysDb.getApiKeys(userId),
    create: (userId, keyName) => apiKeysDb.createApiKey(userId, keyName),
    remove: (userId, keyId) => apiKeysDb.deleteApiKey(userId, keyId),
    toggle: (userId, keyId, isActive) => apiKeysDb.toggleApiKey(userId, keyId, isActive),
  },
  credentials: {
    list: (userId, type) => credentialsDb.getCredentials(userId, type),
    create: (userId, name, type, value, description) =>
      credentialsDb.createCredential(userId, name, type, value, description),
    remove: (userId, credentialId) => credentialsDb.deleteCredential(userId, credentialId),
    toggle: (userId, credentialId, isActive) =>
      credentialsDb.toggleCredential(userId, credentialId, isActive),
  },
  notifications: {
    getPreferences: (userId) => notificationPreferencesDb.getPreferences(userId),
    updatePreferences: (userId, preferences) =>
      notificationPreferencesDb.updatePreferences(userId, preferences),
    createEnabledEvent: () => createNotificationEvent({
      provider: 'system', kind: 'info', code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' }, severity: 'info',
    }),
    notifyUser: (userId, event) => notifyUserIfEnabled({ userId, event }),
  },
  pushSubscriptions: {
    save: (userId, endpoint, p256dh, auth) =>
      pushSubscriptionsDb.saveSubscription(userId, endpoint, p256dh, auth),
    remove: (userId, endpoint) => pushSubscriptionsDb.removeSubscriptionForUser(userId, endpoint),
  },
  getVapidPublicKey: getPublicKey,
});

/** Builds the Settings router with the composition root's startup policy. */
export function createSettingsModule(
  deploymentPolicy?: DeploymentPolicySource,
) {
  return createSettingsRouter(settingsService, { deploymentPolicy });
}

/** Settings router assembled for standalone consumers. */
export const settingsRoutes = createSettingsModule();
