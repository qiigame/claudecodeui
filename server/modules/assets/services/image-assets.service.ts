import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type UploadedAttachmentFile = UploadedImageFile;

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Produces a short direct-child filename for the server-owned attachment
 * store. Browsers may submit path-like names, control characters, very long
 * names, or consecutive dots. The serving boundary deliberately rejects any
 * filename containing `..`, so normalize that spelling before Multer writes
 * the file; otherwise an otherwise valid upload could succeed but become
 * impossible to read back.
 */
export function sanitizeStoredAttachmentName(originalName: string): string {
  const leafName = path.posix.basename(String(originalName ?? '').replace(/\\/g, '/'));
  const normalizedName = leafName
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 180);
  return normalizedName || 'attachment';
}

/** Creates the global `~/.cloudcli/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = getGlobalImageAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/**
 * Maps multer-stored files to provider-neutral attachment records for the
 * assets route. The shared storage format intentionally matches image records
 * so one uploaded file can move through queueing and provider dispatch.
 */
export function buildStoredAttachmentRecords(files: UploadedAttachmentFile[]): StoredImageAsset[] {
  return buildStoredImageRecords(files);
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so nothing outside `~/.cloudcli/assets` can ever be read through it.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  const resolved = path.resolve(assetsDir, trimmed);
  if (!resolved.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Resolves a general chat attachment for the assets serving route. It shares
 * the image resolver's strict direct-child containment boundary.
 */
export function resolveAttachmentAssetFile(filename: string): string | null {
  return resolveImageAssetFile(filename);
}

/**
 * Checks a canonical asset path against its canonical storage directory.
 * Exported for the focused security tests; callers must pass paths already
 * resolved with `realpath`, because lexical checks cannot detect symlink
 * escapes.
 */
export function isCanonicalAssetPathInside(assetsDirectory: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(assetsDirectory), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Opens one stored chat asset for the assets route without exposing arbitrary
 * filesystem reads. The route translates the lookup status and streams the
 * returned direct-child file to the authenticated client.
 */
export async function openStoredAttachmentAsset(filename: string) {
  const resolved = resolveAttachmentAssetFile(filename);
  if (!resolved) {
    return { status: 'invalid' as const };
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  let canonicalAssetsDir: string;
  let canonicalResolved: string;
  try {
    // Resolve both sides before opening the stream. A lexical filename check
    // alone is insufficient when an attacker (or a broken deployment script)
    // places a symlink inside the assets directory that points elsewhere.
    canonicalAssetsDir = await fs.realpath(assetsDir);
    canonicalResolved = await fs.realpath(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'missing' as const };
    }
    return { status: 'invalid' as const };
  }

  if (!isCanonicalAssetPathInside(canonicalAssetsDir, canonicalResolved)) {
    return { status: 'invalid' as const };
  }

  let expectedStats;
  try {
    expectedStats = await fs.stat(canonicalResolved);
    if (!expectedStats.isFile()) {
      return { status: 'missing' as const };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'missing' as const };
    }
    return { status: 'invalid' as const };
  }

  // Open a descriptor and stream from that descriptor instead of reopening the
  // checked pathname.  Between realpath/stat and createReadStream an attacker
  // (or a cleanup job) could replace the direct child with a symlink to an
  // arbitrary file.  O_NOFOLLOW blocks that replacement where the platform
  // supports it; the inode/device comparison covers platforms without the
  // flag and also detects a regular-file replacement race.
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const noFollow = (fsSync.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fileHandle = await fs.open(canonicalResolved, fsSync.constants.O_RDONLY | noFollow);
    const openedStats = await fileHandle.stat();
    if (!openedStats.isFile()
      || openedStats.dev !== expectedStats.dev
      || openedStats.ino !== expectedStats.ino) {
      await fileHandle.close();
      fileHandle = null;
      return { status: 'invalid' as const };
    }

    const stream = fileHandle.createReadStream();
    // Ownership of the descriptor transfers to the stream.  `autoClose` is
    // enabled by default, so the route does not need to know about the handle.
    fileHandle = null;
    return {
      status: 'found' as const,
      contentType: mime.lookup(canonicalResolved) || 'application/octet-stream',
      stream,
    };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'missing' as const };
    }
    return { status: 'invalid' as const };
  }
}
