import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useFileTreeData } from '@/modules/file-tree/hooks/useFileTreeData';
import type { FileTreeNode, Project } from '@/shared/types';

const { getFilesInDirectory } = vi.hoisted(() => ({
  getFilesInDirectory: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: { getFilesInDirectory },
}));

const project: Project = {
  projectId: 'project-1',
  displayName: 'Shared workspace',
  fullPath: '/workspace',
  path: '/workspace',
};

function successfulResponse(entries: FileTreeNode[]): Response {
  return {
    ok: true,
    json: async () => entries,
  } as Response;
}

beforeEach(() => {
  getFilesInDirectory.mockReset();
});

test('loads the project root shallowly and merges children only after expansion', async () => {
  getFilesInDirectory.mockImplementation(async (_projectId: string, directoryPath: string) => {
    if (directoryPath === '.') {
      return successfulResponse([{
        name: 'first-repository',
        path: '/workspace/first-repository',
        type: 'directory',
      }]);
    }
    if (directoryPath === '/workspace/first-repository') {
      return successfulResponse([{
        name: 'README.md',
        path: '/workspace/first-repository/README.md',
        type: 'file',
      }]);
    }
    throw new Error(`Unexpected directory: ${directoryPath}`);
  });

  const { result } = renderHook(() => useFileTreeData(project));

  await waitFor(() => {
    assert.equal(result.current.files[0]?.name, 'first-repository');
  });
  assert.equal(typeof result.current.files[0]?.children, 'undefined');
  assert.equal(getFilesInDirectory.mock.calls[0]?.[1], '.');

  await act(async () => {
    await result.current.loadDirectory('/workspace/first-repository');
  });

  assert.deepEqual(
    result.current.files[0]?.children?.map((entry) => entry.name),
    ['README.md'],
  );
  assert.equal(getFilesInDirectory.mock.calls[1]?.[1], '/workspace/first-repository');
});

test('keeps the existing tree when one expanded directory fails to load', async () => {
  getFilesInDirectory.mockImplementation(async (_projectId: string, directoryPath: string) => {
    if (directoryPath === '.') {
      return successfulResponse([{
        name: 'broken-repository',
        path: '/workspace/broken-repository',
        type: 'directory',
      }]);
    }
    return {
      ok: false,
      text: async () => JSON.stringify({ error: 'Directory cannot be read' }),
    } as Response;
  });

  const { result } = renderHook(() => useFileTreeData(project));
  await waitFor(() => {
    assert.equal(result.current.files.length, 1);
  });

  let loadError: unknown;
  await act(async () => {
    try {
      await result.current.loadDirectory('/workspace/broken-repository');
    } catch (error) {
      loadError = error;
    }
  });

  assert.match(String(loadError), /Directory cannot be read/);
  assert.equal(result.current.files[0]?.name, 'broken-repository');
  assert.equal(result.current.files[0]?.isLoadingChildren, false);
  assert.equal(result.current.error, null);
});

test('refreshes from a new shallow root response instead of retaining stale children', async () => {
  let rootRequestCount = 0;
  getFilesInDirectory.mockImplementation(async (_projectId: string, directoryPath: string) => {
    assert.equal(directoryPath, '.');
    rootRequestCount += 1;
    return successfulResponse([{
      name: rootRequestCount === 1 ? 'before-refresh' : 'after-refresh',
      path: `/workspace/root-${rootRequestCount}`,
      type: 'directory',
    }]);
  });

  const { result } = renderHook(() => useFileTreeData(project));
  await waitFor(() => {
    assert.equal(result.current.files[0]?.name, 'before-refresh');
  });

  act(() => result.current.refreshFiles());

  await waitFor(() => {
    assert.equal(result.current.files[0]?.name, 'after-refresh');
  });
  assert.equal(rootRequestCount, 2);
  assert.equal(typeof result.current.files[0]?.children, 'undefined');
});
