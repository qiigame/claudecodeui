import assert from 'node:assert/strict';

import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Regression guard for the sidebar's loading screen appearing twice per refresh.
 *
 * The mount effect used to depend only on `fetchProjects`, so StrictMode's
 * double-invoked effects issued two `/api/projects` requests. Each one makes the
 * server re-scan every provider transcript and re-broadcast `loading_progress`
 * from zero, so the sidebar replayed its whole progress bar a second time.
 */

const projectsResponse = vi.fn();
const sessionDetailsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: (sessionId: string) => sessionDetailsResponse(sessionId),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const buildProject = (): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
});

type ServerEventListener = (event: { kind: string }) => void;

const listeners = new Set<ServerEventListener>();

const renderProjectsState = async (
  wrapper?: (props: { children: ReactNode }) => ReactNode,
  canManageSettings = false,
) => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(
    () =>
      useProjectsState({
        sessionId: undefined,
        navigate: vi.fn(),
        subscribe: (listener: ServerEventListener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        isMobile: false,
        isSessionProcessing: () => false,
        canManageSettings,
      }),
    wrapper ? { wrapper } : undefined,
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  sessionDetailsResponse.mockReset();
  sessionDetailsResponse.mockResolvedValue({ ok: false });
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject()],
  });
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('the mount fetch runs once even when StrictMode remounts the tree', async () => {
  const { result } = await renderProjectsState(({ children }) => (
    <StrictMode>{children}</StrictMode>
  ));

  await waitFor(() => {
    assert.equal(result.current.isLoadingProjects, false);
  });

  assert.equal(projectsResponse.mock.calls.length, 1);
  assert.equal(result.current.projects.length, 1);
});

test('an explicit refresh still reaches the server after the mount fetch', async () => {
  const { result } = await renderProjectsState(({ children }) => (
    <StrictMode>{children}</StrictMode>
  ));

  await waitFor(() => {
    assert.equal(result.current.isLoadingProjects, false);
  });

  await result.current.refreshProjectsSilently();

  assert.equal(projectsResponse.mock.calls.length, 2);
});

test('an unknown persisted tab falls back to chat', async () => {
  localStorage.setItem('activeTab', 'not-a-workspace-tab');
  const state = await renderProjectsState();

  assert.equal(state.result.current.activeTab, 'chat');
  state.unmount();
});

test('the central settings opener fails closed and opens only for the authorized administrator', async () => {
  const unauthorized = await renderProjectsState();
  await waitFor(() => assert.equal(unauthorized.result.current.isLoadingProjects, false));

  act(() => unauthorized.result.current.openSettings('git'));
  assert.equal(unauthorized.result.current.showSettings, false);

  unauthorized.unmount();
  const authorized = await renderProjectsState(undefined, true);
  await waitFor(() => assert.equal(authorized.result.current.isLoadingProjects, false));

  act(() => authorized.result.current.openSettings('git'));
  await waitFor(() => assert.equal(authorized.result.current.showSettings, true));
  assert.equal(authorized.result.current.settingsInitialTab, 'git');
});

test('an unknown session deep link never inherits the currently selected project', async () => {
  let releaseLookup: (() => void) | null = null;
  const lookupInFlight = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  sessionDetailsResponse.mockImplementationOnce(async () => {
    await lookupInFlight;
    return { ok: false };
  });

  const navigate = vi.fn();
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );
  const { result } = renderHook(() => useProjectsState({
    sessionId: 'unknown-session',
    navigate,
    subscribe: (listener: ServerEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isMobile: false,
    isSessionProcessing: () => false,
  }));

  await waitFor(() => {
    assert.equal(result.current.isLoadingProjects, false);
    assert.equal(sessionDetailsResponse.mock.calls.length, 1);
  });

  act(() => result.current.handleProjectSelect(buildProject()));
  navigate.mockClear();

  await act(async () => {
    releaseLookup?.();
    await lookupInFlight;
  });

  await waitFor(() => {
    assert.deepEqual(navigate.mock.calls, [['/', { replace: true }]]);
  });
  assert.equal(result.current.selectedProject?.projectId, 'project-1');
  assert.equal(result.current.selectedSession, null);
});

test('a selected session outside the loaded page still resolves its authoritative project', async () => {
  const navigate = vi.fn();
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );
  const view = renderHook(
    ({ urlSessionId }: { urlSessionId?: string }) => useProjectsState({
      sessionId: urlSessionId,
      navigate,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
    { initialProps: { urlSessionId: undefined as string | undefined } },
  );

  await waitFor(() => {
    assert.equal(view.result.current.selectedProject?.projectId, 'project-1');
  });

  act(() => view.result.current.handleSessionSelect({
    id: 'older-session',
    __projectId: 'project-2',
    __provider: 'codex',
  } as ProjectSession));
  navigate.mockClear();
  sessionDetailsResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: {
        sessionId: 'older-session',
        provider: 'codex',
        summary: 'Older session',
        project: {
          projectId: 'project-2',
          path: '/repo-2',
          fullPath: '/repo-2',
          displayName: 'Repo 2',
          isStarred: false,
        },
      },
    }),
  });

  view.rerender({ urlSessionId: 'older-session' });

  await waitFor(() => {
    assert.equal(sessionDetailsResponse.mock.calls.length, 1);
    assert.equal(view.result.current.selectedProject?.projectId, 'project-2');
    assert.equal(view.result.current.selectedSession?.id, 'older-session');
  });
  assert.equal(view.result.current.selectedSession?.__projectId, 'project-2');
  assert.deepEqual(navigate.mock.calls, []);
});

test('a session whose project no longer exists cannot inherit another project', async () => {
  const navigate = vi.fn();
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );
  const view = renderHook(
    ({ urlSessionId }: { urlSessionId?: string }) => useProjectsState({
      sessionId: urlSessionId,
      navigate,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
    { initialProps: { urlSessionId: undefined as string | undefined } },
  );

  await waitFor(() => {
    assert.equal(view.result.current.selectedProject?.projectId, 'project-1');
  });

  act(() => view.result.current.handleSessionSelect({
    id: 'orphaned-session',
    __provider: 'claude',
  } as ProjectSession));
  navigate.mockClear();
  sessionDetailsResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: {
        sessionId: 'orphaned-session',
        provider: 'claude',
        summary: 'Orphaned session',
        project: null,
      },
    }),
  });

  view.rerender({ urlSessionId: 'orphaned-session' });

  await waitFor(() => {
    assert.deepEqual(navigate.mock.calls, [['/', { replace: true }]]);
  });
  assert.equal(view.result.current.selectedProject, null);
  assert.equal(view.result.current.selectedSession, null);
});
