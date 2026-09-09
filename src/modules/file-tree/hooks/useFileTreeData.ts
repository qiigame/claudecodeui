import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { FileTreeNode, Project } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  loadDirectory: (directoryPath: string) => Promise<void>;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

function updateDirectoryNode(
  nodes: FileTreeNode[],
  directoryPath: string,
  update: (node: FileTreeNode) => FileTreeNode,
): FileTreeNode[] {
  let changed = false;
  const updatedNodes = nodes.map((node) => {
    if (node.path === directoryPath && node.type === 'directory') {
      changed = true;
      return update(node);
    }

    if (!node.children) {
      return node;
    }

    const updatedChildren = updateDirectoryNode(node.children, directoryPath, update);
    if (updatedChildren === node.children) {
      return node;
    }

    changed = true;
    return { ...node, children: updatedChildren };
  });

  return changed ? updatedNodes : nodes;
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const directoryRequestsRef = useRef(new Map<
    string,
    { controller: AbortController; request: Promise<void> }
  >());

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;
    const directoryRequests = directoryRequestsRef.current;
    activeProjectIdRef.current = projectId ?? null;

    directoryRequests.forEach(({ controller }) => controller.abort());
    directoryRequests.clear();

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await api.getFilesInDirectory(
          projectId,
          '.',
          { signal: abortControllerRef.current!.signal },
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setError(DEFAULT_LOAD_ERROR);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
      directoryRequests.forEach(({ controller }) => controller.abort());
      directoryRequests.clear();
    };
  }, [selectedProject?.projectId, refreshKey]);

  const loadDirectory = useCallback(async (directoryPath: string): Promise<void> => {
    const projectId = selectedProject?.projectId;
    if (!projectId) {
      return;
    }

    const existingRequest = directoryRequestsRef.current.get(directoryPath);
    if (existingRequest) {
      return existingRequest.request;
    }

    const controller = new AbortController();
    setFiles((currentFiles) => updateDirectoryNode(
      currentFiles,
      directoryPath,
      (node) => ({ ...node, isLoadingChildren: true }),
    ));

    const request = (async () => {
      try {
        const response = await api.getFilesInDirectory(projectId, directoryPath, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const responseBody = await response.text();
          throw new Error(readResponseErrorMessage(responseBody) ?? DEFAULT_LOAD_ERROR);
        }

        const children = (await response.json()) as FileTreeNode[];
        if (activeProjectIdRef.current === projectId) {
          setFiles((currentFiles) => updateDirectoryNode(
            currentFiles,
            directoryPath,
            (node) => ({ ...node, children, isLoadingChildren: false }),
          ));
        }
      } catch (loadError) {
        if ((loadError as { name?: string }).name === 'AbortError') {
          return;
        }
        if (activeProjectIdRef.current === projectId) {
          setFiles((currentFiles) => updateDirectoryNode(
            currentFiles,
            directoryPath,
            (node) => ({ ...node, isLoadingChildren: false }),
          ));
        }
        throw loadError;
      } finally {
        if (directoryRequestsRef.current.get(directoryPath)?.controller === controller) {
          directoryRequestsRef.current.delete(directoryPath);
        }
      }
    })();

    directoryRequestsRef.current.set(directoryPath, { controller, request });
    return request;
  }, [selectedProject?.projectId]);

  return {
    files,
    loading,
    error,
    refreshFiles,
    loadDirectory,
  };
}
