import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  filterAttachmentsToUploadStore,
  filterImagesToUploadStore,
} from '@/modules/websocket/services/chat-websocket.service.js';

const STORE = path.join(os.tmpdir(), 'cloudcli-assets-store');

test('images inside the upload store pass through', () => {
  const inside = path.join(STORE, 'shot.png');
  const result = filterImagesToUploadStore(
    [{ path: inside, name: 'shot.png', mimeType: 'image/png' }],
    STORE,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, inside);
});

test('bare filenames are anchored inside the store', () => {
  const result = filterImagesToUploadStore(['shot.png'], STORE);
  assert.equal(result.length, 1);
});

test('paths outside the store, traversal, and subdirs are dropped', () => {
  const result = filterImagesToUploadStore(
    [
      { path: 'C:/Users/victim/.ssh/id_rsa' },
      { path: '/etc/passwd' },
      { path: '../outside.png' },
      { path: path.join(STORE, '..', 'escaped.png') },
      { path: path.join(STORE, 'nested', 'deep.png') },
      { path: STORE }, // the store folder itself is not a file
    ],
    STORE,
  );
  assert.deepEqual(result, []);
});

test('malformed payloads yield no attachments', () => {
  assert.deepEqual(filterImagesToUploadStore(undefined, STORE), []);
  assert.deepEqual(filterImagesToUploadStore('nope', STORE), []);
  assert.deepEqual(filterImagesToUploadStore([{ name: 'no-path' }, 42], STORE), []);
});

test('general files inside the upload store preserve their metadata', () => {
  const inside = path.join(STORE, 'brief.pdf');
  const result = filterAttachmentsToUploadStore(
    [{ path: inside, name: 'brief.pdf', mimeType: 'application/pdf', size: 2048 }],
    STORE,
  );

  assert.deepEqual(result, [
    { path: inside, name: 'brief.pdf', mimeType: 'application/pdf', size: 2048 },
  ]);
});

test('attachments that are symlinks outside the upload store are dropped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-attachment-filter-'));
  const store = path.join(root, 'assets');
  const outside = path.join(root, 'outside-secret.txt');
  const link = path.join(store, 'brief.pdf');
  try {
    await mkdir(store, { recursive: true });
    await writeFile(outside, 'not for the provider');
    await symlink(outside, link);

    assert.deepEqual(
      filterAttachmentsToUploadStore([{ path: link }], store),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
