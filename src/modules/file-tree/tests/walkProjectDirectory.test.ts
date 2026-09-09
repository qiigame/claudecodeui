import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

import { walkProjectDirectory } from '@/modules/file-tree/utils/walkProjectDirectory';
import type { FileTreeNode } from '@/shared/types';

const { getFilesInDirectory } = vi.hoisted(() => ({
  getFilesInDirectory: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: { getFilesInDirectory },
  readApiJson: async (response: Response) => {
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? 'Request failed');
    }
    return payload;
  },
}));

function successfulResponse(entries: FileTreeNode[]): Response {
  return {
    ok: true,
    json: async () => entries,
  } as Response;
}

beforeEach(() => {
  getFilesInDirectory.mockReset();
});

test('walks every directory through the API instead of trusting lazy UI children', async () => {
  getFilesInDirectory.mockImplementation(async (_projectId: string, directoryPath: string) => {
    if (directoryPath === '/workspace/repository') {
      return successfulResponse([
        { name: 'README.md', path: '/workspace/repository/README.md', type: 'file' },
        { name: 'docs', path: '/workspace/repository/docs', type: 'directory' },
      ]);
    }
    if (directoryPath === '/workspace/repository/docs') {
      return successfulResponse([
        { name: 'guide.md', path: '/workspace/repository/docs/guide.md', type: 'file' },
      ]);
    }
    throw new Error(`Unexpected directory: ${directoryPath}`);
  });
  const visited: Array<{ name: string; relativePath: string }> = [];

  await walkProjectDirectory({
    projectId: 'project-1',
    directoryPath: '/workspace/repository',
    onEntry: (entry, relativePath) => {
      visited.push({ name: entry.name, relativePath });
    },
  });

  assert.deepEqual(
    getFilesInDirectory.mock.calls.map((call) => call[1]),
    ['/workspace/repository', '/workspace/repository/docs'],
  );
  assert.deepEqual(visited, [
    { name: 'README.md', relativePath: 'README.md' },
    { name: 'docs', relativePath: 'docs' },
    { name: 'guide.md', relativePath: 'docs/guide.md' },
  ]);
});
