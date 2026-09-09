import { api } from '@/shared/api';
import type { FolderSuggestion, GithubTokenCredential, TokenMode } from '@/shared/types';

type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

type CreateProjectPayload = {
  path: string;
  customName?: string;
};

type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

type CloneProgressEvent = {
  type?: string;
  message?: string;
  project?: Record<string, unknown>;
};

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const fetchGithubTokenCredentials = async () => {
  const response = await api.settings.credentials('github_token');
  const data = await parseJson<CredentialsResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load GitHub tokens');
  }

  return (data.credentials || []).filter((credential) => credential.is_active);
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const response = await api.browseFilesystem(pathToBrowse);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const createProjectRequest = async (payload: CreateProjectPayload) => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    throw new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create project');
  }

  return data.project;
};

const buildCloneProgressPayload = ({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
}: CloneWorkspaceParams) =>
  ({
    path: workspacePath.trim(),
    githubUrl: githubUrl.trim(),
    githubTokenId: tokenMode === 'stored' ? selectedGithubToken : null,
    newGithubToken: tokenMode === 'new' ? newGithubToken.trim() : null,
  });

/** Parse one complete Server-Sent Events record into the clone protocol payload. */
const parseCloneProgressEvent = (rawEvent: string): CloneProgressEvent | null => {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''));

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join('\n')) as CloneProgressEvent;
};

const cloneProgressErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      message?: unknown;
      details?: unknown;
    };
    for (const candidate of [payload.error, payload.message, payload.details]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
  } catch {
    // Fall through to the stable generic message when the error body is not
    // JSON (for example, a proxy-generated HTML response).
  }
  return 'Failed to clone repository';
};

/**
 * Clone over an authenticated POST and consume the same SSE wire protocol.
 * EventSource cannot carry an Authorization header, which previously forced
 * the raw GitHub token into the URL. Fetch keeps credentials in the request
 * body while preserving progress/complete/error events for the wizard.
 */
export const cloneWorkspaceWithProgress = async (
  params: CloneWorkspaceParams,
  handlers: CloneProgressHandlers,
): Promise<Record<string, unknown> | undefined> => {
  const response = await api.cloneProjectProgress(buildCloneProgressPayload(params));
  if (!response.ok) {
    throw new Error(await cloneProgressErrorMessage(response));
  }

  if (!response.body) {
    throw new Error('Connection lost during clone');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let project: Record<string, unknown> | undefined;

  const consumeEvent = (rawEvent: string): void => {
    const payload = parseCloneProgressEvent(rawEvent);
    if (!payload) {
      return;
    }

    if (payload.type === 'progress' && payload.message) {
      handlers.onProgress(payload.message);
      return;
    }

    if (payload.type === 'error') {
      throw new Error(payload.message || 'Failed to clone repository');
    }

    if (payload.type === 'complete') {
      completed = true;
      project = payload.project;
    }
  };

  const consumeBufferedEvents = (flush = false): void => {
    // SSE permits either LF or CRLF separators. Keep incomplete records in
    // `buffer` so a token-bearing payload split across network chunks is never
    // parsed/logged prematurely.
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer);
      if (!separator || separator.index === undefined) {
        break;
      }
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      consumeEvent(rawEvent);
      if (completed) {
        return;
      }
    }

    if (flush && buffer.trim()) {
      const trailingEvent = buffer;
      buffer = '';
      consumeEvent(trailingEvent);
    }
  };

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      consumeBufferedEvents(done);
      if (done) {
        break;
      }
    }
  } catch (error) {
    // Match EventSource.close(): if parsing or the transport fails, close the
    // fetch body so the server's request-close hook can cancel an active clone.
    try {
      await reader.cancel();
    } catch {
      // Preserve the original protocol/transport error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!completed) {
    throw new Error('Connection lost during clone');
  }

  return project;
};
