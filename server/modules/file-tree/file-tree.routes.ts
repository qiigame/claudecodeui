import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  createDeploymentPolicyGuard,
  DEPLOYMENT_CAPABILITIES,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import type {
  FileTreeLogger,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type FileTreeUploadLimits = {
  maximumFileSizeMegabytes: number;
  maximumFileCount: number;
};

type UploadedRequest = Request & {
  files?: Express.Multer.File[];
};

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readBody(request: Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, fieldName: string, message?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(message ?? `${fieldName} is required`, {
      code: 'INVALID_FILE_TREE_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readProjectId(request: Request): string {
  return readRequiredString(request.params.projectId, 'projectId');
}

function readEntryType(value: unknown): 'file' | 'directory' {
  if (value !== 'file' && value !== 'directory') {
    throw new AppError('Type must be "file" or "directory"', {
      code: 'INVALID_FILE_TREE_ENTRY_TYPE',
      statusCode: 400,
    });
  }
  return value;
}

function readRelativePaths(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function readRequestedFileCount(value: unknown, fallbackCount: number): number {
  const parsedCount = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : fallbackCount;
}

function normalizeUploadedFiles(request: UploadedRequest): FileTreeUploadedFile[] {
  return Array.isArray(request.files)
    ? request.files.map((file) => ({
        originalName: file.originalname,
        temporaryPath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      }))
    : [];
}

/**
 * Maps multipart parser failures to stable client-facing messages. Multer and
 * filesystem adapters may include temporary paths, original filenames, or
 * operating-system details in `error.message`; those are useful in the server
 * log but are not safe to echo to a product/QA browser.
 */
function uploadErrorMessage(error: unknown, uploadLimits: FileTreeUploadLimits): string {
  const errorCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (errorCode === 'LIMIT_FILE_SIZE') {
    return `File too large. Maximum size is ${uploadLimits.maximumFileSizeMegabytes}MB.`;
  }
  if (errorCode === 'LIMIT_FILE_COUNT') {
    return `Too many files. Maximum is ${uploadLimits.maximumFileCount} files.`;
  }
  if (errorCode === 'LIMIT_UNEXPECTED_FILE') {
    return 'Unexpected file field.';
  }
  if (errorCode === 'LIMIT_FIELD_COUNT' || errorCode === 'LIMIT_PART_COUNT') {
    return 'Upload contains too many parts.';
  }
  if (errorCode === 'LIMIT_FIELD_KEY' || errorCode === 'LIMIT_FIELD_VALUE') {
    return 'Upload field is invalid.';
  }
  return 'Upload failed.';
}

// Service errors can carry filesystem validation text (including an absolute
// workspace path) when a legacy project row or adapter supplies it.  Keep the
// transport contract useful for ordinary validation failures while mapping
// every known error code to a stable public message; an unknown code must not
// turn into an internal path/error oracle for product and QA users.
const FILE_TREE_PUBLIC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_FILE_TREE_REQUEST: 'Invalid file tree request.',
  INVALID_FILE_TREE_ENTRY_TYPE: 'Type must be "file" or "directory"',
  FILE_CONTENT_REQUIRED: 'Content is required',
  INVALID_FILE_CONTENT: 'Content must be a string',
  PATH_OUTSIDE_PROJECT: 'Path must be under project root',
  INVALID_WORKSPACE_PATH: 'Path is outside the workspace root',
  PROJECT_NOT_FOUND: 'Project not found',
  PROJECT_PATH_NOT_FOUND: 'Project path not found',
  NOT_A_DIRECTORY: 'Path is not a directory',
  DIRECTORY_NOT_ACCESSIBLE: 'Directory not accessible',
  PARENT_DIRECTORY_NOT_FOUND: 'Parent directory does not exist',
  FOLDER_ALREADY_EXISTS: 'Folder already exists',
  INVALID_FILENAME: 'Filename is invalid',
  FILE_TREE_ENTRY_FIELDS_REQUIRED: 'Name and type are required',
  FILE_TREE_RENAME_FIELDS_REQUIRED: 'oldPath and newName are required',
  FILE_TREE_ENTRY_EXISTS: 'A file or directory with this name already exists',
  FILE_TREE_ENTRY_NOT_FOUND: 'File or directory not found',
  PROJECT_ROOT_DELETE_FORBIDDEN: 'Cannot delete project root directory',
  FILE_TREE_TOO_LARGE: 'The project file tree is too large. Choose a narrower project directory or add ignore rules.',
  UPLOAD_FILES_REQUIRED: 'No files provided',
  EACCES: 'Permission denied',
};

function publicFileTreeErrorMessage(error: AppError): string {
  return FILE_TREE_PUBLIC_ERROR_MESSAGES[error.code]
    ?? (error.statusCode >= 500 ? 'File Tree request failed.' : 'File Tree request could not be completed.');
}

function createRouteHandler(
  operation: (request: Request, response: Response) => void | Promise<void>,
  logger: FileTreeLogger,
): RequestHandler {
  return async (request, response) => {
    try {
      await operation(request, response);
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.statusCode).json({ error: publicFileTreeErrorMessage(error) });
        return;
      }

      logger.error('File Tree API error', error);
      response.status(500).json({ error: 'File Tree request failed.' });
    }
  };
}

/**
 * Builds the File Tree HTTP router for the server composition root and route tests.
 * Paths are relative to the module's `/api/file-tree` mount point so the
 * complete HTTP surface has one feature-owned namespace.
 */
export function createFileTreeRouter(
  services: FileTreeServices,
  uploadFilesMiddleware: RequestHandler,
  uploadLimits: FileTreeUploadLimits,
  logger: FileTreeLogger,
  capabilityGuard?: (operation: string) => RequestHandler,
): express.Router {
  const router = express.Router();

  // A production composition root injects its immutable startup policy.  An
  // alternate/standalone host may omit that adapter, so resolve a trusted
  // process policy once at factory creation instead of silently allowing every
  // mutation when the guard is absent.  This keeps local developer behavior
  // (the default self-hosted profile is writable) while honoring a configured
  // product/QA read-only profile.
  const effectiveCapabilityGuard = capabilityGuard ?? (() => {
    const fallbackPolicy = parseDeploymentPolicy();
    return (operation: string) => createDeploymentPolicyGuard({
      policy: fallbackPolicy,
      capability: operation,
    });
  })();

  // `browse-filesystem` is intentionally broader than the project-id based
  // file routes below: it starts at the configured workspace root (which
  // defaults to the service account's HOME) and is used by the project
  // creation wizard.  In the product/QA deployment that endpoint would turn
  // a harmless-looking GET into a directory/filename oracle for credentials,
  // SSH keys, and other unrelated folders.  The production composition root
  // therefore supplies the deployment guard and requires the explicit local
  // filesystem capability; read-only profiles do not carry that capability.
  // Resolve a capability middleware only when its route is actually reached.
  // This keeps route construction side-effect free for alternate hosts while
  // still using the one captured policy/guard supplied by the composition root.
  const browseWorkspaceGuard: RequestHandler = (request, response, next) => {
    try {
      effectiveCapabilityGuard('local-filesystem')(request, response, next);
    } catch (error) {
      next(error);
    }
  };
  const fileReadGuard: RequestHandler = (request, response, next) => {
    try {
      effectiveCapabilityGuard(DEPLOYMENT_CAPABILITIES.FILE_READ)(request, response, next);
    } catch (error) {
      next(error);
    }
  };

  // File Tree's non-read methods all mutate a project/workspace path. Keep
  // this check at the router boundary so the upload middleware is never
  // invoked for a denied request (and therefore cannot leave temporary files
  // behind).
  router.use((request, response, next) => {
    if (READ_ONLY_METHODS.has(request.method.toUpperCase())) {
      fileReadGuard(request, response, next);
      return;
    }

    try {
      // File Tree writes mutate arbitrary files/directories inside a project;
      // keep them behind the dedicated file capability rather than the broader
      // repository-level write grant used by Git operations.
      effectiveCapabilityGuard('file.write')(request, response, next);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/browse-filesystem',
    browseWorkspaceGuard,
    createRouteHandler(async (request, response) => {
    response.json(await services.browseWorkspace(readOptionalString(request.query.path)));
    }, logger),
  );

  router.post('/create-folder', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const folderPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.createWorkspaceFolder(folderPath));
  }, logger));

  router.get('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.filePath, 'filePath', 'Invalid file path');
    response.json(await services.readTextFile(readProjectId(request), filePath));
  }, logger));

  router.get('/projects/:projectId/files/content', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    const file = await services.openFile(readProjectId(request), filePath);
    response.setHeader('Content-Type', file.contentType);
    file.stream.pipe(response);
    file.stream.on('error', (error) => {
      logger.error('Error streaming File Tree content', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Error reading file' });
      }
    });
  }, logger));

  router.put('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.filePath, 'filePath', 'Invalid file path');
    if (body.content === undefined) {
      throw new AppError('Content is required', {
        code: 'FILE_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }
    if (typeof body.content !== 'string') {
      throw new AppError('Content must be a string', {
        code: 'INVALID_FILE_CONTENT',
        statusCode: 400,
      });
    }
    response.json(await services.saveTextFile(readProjectId(request), filePath, body.content));
  }, logger));

  router.get('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const directoryPath = readOptionalString(request.query.directoryPath);
    response.json(await services.listProjectFiles(readProjectId(request), {
      respectGitignore: request.query.respectGitignore === 'true',
      ...(directoryPath === null ? {} : { directoryPath }),
    }));
  }, logger));

  router.post('/projects/:projectId/files/create', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.name || !body.type) {
      throw new AppError('Name and type are required', {
        code: 'FILE_TREE_ENTRY_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    const name = readRequiredString(body.name, 'name');
    const type = readEntryType(body.type);
    const parentPath = readOptionalString(body.path) ?? '';
    response.json(await services.createEntry({
      projectId: readProjectId(request),
      parentPath,
      type,
      name,
    }));
  }, logger));

  router.put('/projects/:projectId/files/rename', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.oldPath || !body.newName) {
      throw new AppError('oldPath and newName are required', {
        code: 'FILE_TREE_RENAME_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    response.json(await services.renameEntry({
      projectId: readProjectId(request),
      oldPath: readRequiredString(body.oldPath, 'oldPath'),
      newName: readRequiredString(body.newName, 'newName'),
    }));
  }, logger));

  router.delete('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const targetPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.deleteEntry({
      projectId: readProjectId(request),
      targetPath,
    }));
  }, logger));

  const uploadHandler = createRouteHandler(async (request, response) => {
    const uploadedRequest = request as UploadedRequest;
    const body = readBody(request);
    const files = normalizeUploadedFiles(uploadedRequest);
    response.json(await services.storeUploadedFiles({
      projectId: readProjectId(request),
      targetPath: readOptionalString(body.targetPath) ?? '',
      relativePaths: readRelativePaths(body.relativePaths),
      requestedFileCount: readRequestedFileCount(body.requestedFileCount, files.length),
      files,
    }));
  }, logger);

  router.post(
    '/projects/:projectId/files/upload',
    (request: Request, response: Response, next: NextFunction) => {
      uploadFilesMiddleware(request, response, (error?: unknown) => {
        if (!error) {
          void uploadHandler(request, response, next);
          return;
        }

        const errorCode = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
        const isMulterLimit = errorCode.startsWith('LIMIT_');
        response.status(isMulterLimit ? 400 : 500).json({
          error: uploadErrorMessage(error, uploadLimits),
        });
      });
    },
  );

  return router;
}
