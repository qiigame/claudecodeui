import express, { type RequestHandler } from 'express';
import multer from 'multer';

import {
  captureDeploymentPolicy,
  createDeploymentPolicyGuard,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  ensureImageAssetsDir,
  isAllowedImageMimeType,
  openStoredAttachmentAsset,
  sanitizeStoredAttachmentName,
} from '@/modules/assets/services/image-assets.service.js';

const MAX_CHAT_ATTACHMENT_SIZE_MB = 50;
const MAX_CHAT_ATTACHMENT_SIZE_BYTES = MAX_CHAT_ATTACHMENT_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_FILE_COUNT = 5;
const MAX_ATTACHMENT_FILE_COUNT = 10;
const INVALID_IMAGE_FILE_TYPE_MESSAGE =
  'Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.';

// Multer writes uploads straight into the global assets folder; the service
// owns the folder location and the response record shape.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureImageAssetsDir()
      .then((assetsDir) => cb(null, assetsDir))
      .catch((error) => cb(error as Error, ''));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const sanitizedName = sanitizeStoredAttachmentName(file.originalname);
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (isAllowedImageMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(INVALID_IMAGE_FILE_TYPE_MESSAGE));
    }
  },
  limits: {
    fileSize: MAX_CHAT_ATTACHMENT_SIZE_BYTES,
    files: MAX_IMAGE_FILE_COUNT,
  },
});

const attachmentUpload = multer({
  storage,
  limits: {
    fileSize: MAX_CHAT_ATTACHMENT_SIZE_BYTES,
    files: MAX_ATTACHMENT_FILE_COUNT,
  },
});

/**
 * Converts Multer/storage failures into a stable client-facing response.
 * Storage errors can contain absolute temporary paths or operating-system
 * details, so their original message is logged by the server but never sent
 * to a product/QA browser.
 */
export function assetUploadErrorResponse(
  error: unknown,
  maximumFileCount: number,
): { statusCode: number; message: string } {
  const errorCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (errorCode === 'LIMIT_FILE_SIZE') {
    return {
      statusCode: 400,
      message: `File too large. Maximum size is ${MAX_CHAT_ATTACHMENT_SIZE_MB}MB.`,
    };
  }
  if (errorCode === 'LIMIT_FILE_COUNT') {
    return {
      statusCode: 400,
      message: `Too many files. Maximum is ${maximumFileCount} files.`,
    };
  }
  if (errorCode === 'LIMIT_UNEXPECTED_FILE') {
    return { statusCode: 400, message: 'Unexpected file field.' };
  }
  if (errorCode === 'LIMIT_FIELD_COUNT' || errorCode === 'LIMIT_PART_COUNT') {
    return { statusCode: 400, message: 'Upload contains too many parts.' };
  }
  if (errorCode === 'LIMIT_FIELD_KEY' || errorCode === 'LIMIT_FIELD_VALUE') {
    return { statusCode: 400, message: 'Upload field is invalid.' };
  }
  if (error instanceof Error && error.message === INVALID_IMAGE_FILE_TYPE_MESSAGE) {
    return { statusCode: 400, message: INVALID_IMAGE_FILE_TYPE_MESSAGE };
  }
  return { statusCode: 500, message: 'Upload failed.' };
}

/**
 * Creates the assets router with an optional deployment capability guard.
 * Keeping the guard injectable ensures the production composition root uses
 * its immutable startup policy rather than reparsing mutable environment
 * variables for each request. Standalone consumers receive the safe default.
 */
export function createAssetsRouter(
  capabilityGuard?: (operation: string) => RequestHandler,
  options: { deploymentPolicy?: DeploymentPolicySource } = {},
): express.Router {
  const router = express.Router();
  // Capture the standalone fallback at router construction. The production
  // composition root supplies its guard and policy; alternate mounts must
  // not re-read mutable process.env for each multipart request.
  const startupPolicy = capabilityGuard
    ? undefined
    : captureDeploymentPolicy(options.deploymentPolicy);
  // Crucially this middleware runs before Multer, so denied multipart requests
  // cannot leave temporary or permanent files behind.
  const attachmentUploadCapabilityGuard = capabilityGuard
    ? capabilityGuard('attachment.upload')
    : createDeploymentPolicyGuard({
      policy: startupPolicy!,
      capability: 'attachment.upload',
    });
  // Serving an attachment opens a server-owned file descriptor. Keep the
  // read capability explicit even though the outer production mutation guard
  // intentionally skips GET/HEAD/OPTIONS requests; a custom policy may deny
  // file reads while still allowing metadata/session access.
  const assetReadCapabilityGuard = capabilityGuard
    ? capabilityGuard('file.read')
    : createDeploymentPolicyGuard({
      policy: startupPolicy!,
      capability: 'file.read',
    });

  /**
   * Stores chat image attachments in the global `~/.cloudcli/assets` folder and
   * returns their absolute paths for use in provider prompts and chat history.
   */
  router.post('/images', attachmentUploadCapabilityGuard, (req, res) => {
    upload.array('images', 5)(req, res, (err: unknown) => {
      if (err) {
        const publicError = assetUploadErrorResponse(err, MAX_IMAGE_FILE_COUNT);
        console.error('Image asset upload failed:', err);
        return res.status(publicError.statusCode).json({ error: publicError.message });
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No image files provided' });
      }

      res.json({ images: buildStoredImageRecords(files) });
    });
  });

  /**
   * Stores provider-neutral chat attachments. Files of any MIME type are
   * accepted because providers inspect them as data through their file-reading
   * tools; uploads are capped at 10 files and 50MB per file.
   */
  router.post('/files', attachmentUploadCapabilityGuard, (req, res) => {
    attachmentUpload.array('files', 10)(req, res, (err: unknown) => {
      if (err) {
        const publicError = assetUploadErrorResponse(err, MAX_ATTACHMENT_FILE_COUNT);
        console.error('File attachment upload failed:', err);
        return res.status(publicError.statusCode).json({ error: publicError.message });
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files provided' });
      }

      res.json({ attachments: buildStoredAttachmentRecords(files) });
    });
  });

  /**
   * Serves one stored image asset by filename. Only files directly inside the
   * global assets folder are reachable; traversal attempts resolve to null.
   */
  router.get('/images/:filename', assetReadCapabilityGuard, async (req, res) => {
    const asset = await openStoredAttachmentAsset(req.params.filename);
    if (asset.status === 'invalid') {
      return res.status(400).json({ error: 'Invalid asset filename' });
    }
    if (asset.status === 'missing') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    // The image and general-attachment upload APIs intentionally share one
    // storage directory.  Do not let a caller reinterpret an uploaded HTML,
    // JavaScript, or other active attachment through the `/images` route:
    // that would turn a downloaded attachment into a stored-XSS response.
    // `openStoredAttachmentAsset` has already opened the checked descriptor,
    // so close it before returning the deliberately indistinguishable 404.
    if (!isAllowedImageMimeType(asset.contentType)) {
      asset.stream.destroy();
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.setHeader('Content-Type', asset.contentType);
    // Stored-XSS hardening: never let the browser sniff a different type, and
    // force SVGs (which can carry scripts when rendered as a document) to
    // download instead of rendering inline. The chat UI is unaffected — it
    // fetches assets as blobs and shows them through <img>, where SVG scripts
    // never execute.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (asset.contentType === 'image/svg+xml') {
      res.setHeader('Content-Disposition', 'attachment');
    }
    asset.stream.pipe(res);
    asset.stream.on('error', (error) => {
      console.error('Error streaming image asset:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading asset' });
      }
    });
  });

  /**
   * Downloads one stored non-image attachment. Content-Disposition prevents
   * uploaded HTML or other active formats from rendering in the application.
   */
  router.get('/files/:filename', assetReadCapabilityGuard, async (req, res) => {
    const asset = await openStoredAttachmentAsset(req.params.filename);
    if (asset.status === 'invalid') {
      return res.status(400).json({ error: 'Invalid asset filename' });
    }
    if (asset.status === 'missing') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename.replace(/["\r\n]/g, '_')}"`);
    asset.stream.pipe(res);
    asset.stream.on('error', (error) => {
      console.error('Error streaming attachment asset:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading asset' });
      }
    });
  });

  return router;
}

const router = createAssetsRouter();

export default router;
