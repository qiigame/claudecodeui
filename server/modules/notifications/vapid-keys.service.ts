// @ts-nocheck -- web-push does not provide declarations in this project.
import webPush from 'web-push';

import { getConnection } from '../database/index.js';

let cachedKeys = null;
const db = getConnection();

/**
 * Reads the server-owned key pair without creating one.  Public HTTP reads
 * must stay observational: a missing row should not turn a GET into a DB
 * mutation (particularly in a product/QA deployment whose state store may
 * be mounted with a narrower write policy).
 */
function readStoredVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;

  cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
  return cachedKeys;
}

function ensureVapidKeys() {
  const storedKeys = readStoredVapidKeys();
  if (storedKeys) return storedKeys;

  const keys = webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey() {
  return readStoredVapidKeys()?.publicKey ?? null;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@claudecodeui.local',
    keys.publicKey,
    keys.privateKey
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
