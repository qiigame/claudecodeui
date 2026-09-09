import { api, readApiJson } from '@/shared/api';
import type { FileTreeNode } from '@/shared/types';

const MAXIMUM_WALKED_DIRECTORY_ENTRIES = 10_000;

type WalkProjectDirectoryOptions = {
  projectId: string;
  directoryPath: string;
  onEntry: (entry: FileTreeNode, relativePath: string) => void | Promise<void>;
};

/**
 * Used by folder ZIP export to visit a complete directory independently of
 * which rows the lazy browser tree currently has expanded.
 */
export async function walkProjectDirectory({
  projectId,
  directoryPath,
  onEntry,
}: WalkProjectDirectoryOptions): Promise<void> {
  let visitedEntries = 0;

  const visitDirectory = async (
    currentDirectoryPath: string,
    relativeDirectoryPath: string,
  ): Promise<void> => {
    const response = await api.getFilesInDirectory(projectId, currentDirectoryPath);
    const entries = await readApiJson<FileTreeNode[]>(response);

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAXIMUM_WALKED_DIRECTORY_ENTRIES) {
        throw new Error(
          `Folder download exceeds the ${MAXIMUM_WALKED_DIRECTORY_ENTRIES.toLocaleString()} entry limit.`,
        );
      }

      const relativePath = relativeDirectoryPath
        ? `${relativeDirectoryPath}/${entry.name}`
        : entry.name;
      await onEntry(entry, relativePath);

      if (entry.type === 'directory') {
        await visitDirectory(entry.path, relativePath);
      }
    }
  };

  await visitDirectory(directoryPath, '');
}
