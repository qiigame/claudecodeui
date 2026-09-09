import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, test, vi } from 'vitest';

import CommandPalette from '@/modules/command-palette/CommandPalette';
import type { Project } from '@/shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { label?: string }) => key === 'commandPalette.settingsItem'
      ? `Settings: ${options?.label ?? ''}`
      : key,
  }),
}));

const authState = vi.hoisted(() => ({ canManageSettings: false }));
const deploymentState = vi.hoisted(() => ({
  isReadOnly: true,
  can: vi.fn((capability: string) => capability === 'terminal.readonly'),
}));

vi.mock('@/modules/auth', () => ({
  useAuth: () => authState,
  isManagedIdentityRestricted: () => false,
}));

vi.mock('@/shared/context/DeploymentPolicyContext', () => ({
  useDeploymentPolicy: () => deploymentState,
}));

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    taskMasterUiEnabled: false,
  };
});

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ toggleDarkMode: vi.fn() }),
}));

vi.mock('@/modules/command-palette/context/PaletteOpsContext', () => ({
  usePaletteOps: () => ({
    openFile: vi.fn(),
    openFileInEditor: vi.fn(),
    openSettings: vi.fn(),
    refreshProjects: vi.fn(),
  }),
}));

vi.mock('@/modules/command-palette/hooks/useSessionsSource', () => ({ useSessionsSource: () => [] }));
vi.mock('@/modules/command-palette/hooks/useFilesSource', () => ({
  useFilesSource: () => [{ path: 'src/hidden.ts', name: 'hidden.ts' }],
}));
vi.mock('@/modules/command-palette/hooks/useCommitsSource', () => ({
  useCommitsSource: () => [{ hash: 'abcdef123', shortHash: 'abcdef1', message: 'hidden commit', author: 'Tester' }],
}));
vi.mock('@/modules/command-palette/hooks/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
vi.mock('@/modules/command-palette/hooks/useBranchesSource', () => ({
  useBranchesSource: () => [{ name: 'hidden-branch' }],
}));
vi.mock('@/modules/command-palette/hooks/useGitActions', () => ({
  useGitActions: () => ({ fetch: vi.fn(), pull: vi.fn(), push: vi.fn() }),
}));

const selectedProject = {
  projectId: 'project-1',
  displayName: 'Project One',
  path: '/workspace/project-one',
  fullPath: '/workspace/project-one',
  sessions: [],
} as Project;

const renderPalette = () => render(
  <MemoryRouter>
    <CommandPalette
      selectedProject={selectedProject}
      onStartNewChat={vi.fn()}
      onOpenSettings={vi.fn()}
      onShowTab={vi.fn()}
    />
  </MemoryRouter>,
);

const openPalette = () => {
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
};

beforeEach(() => {
  authState.canManageSettings = false;
  deploymentState.isReadOnly = true;
  deploymentState.can.mockImplementation((capability: string) => capability === 'terminal.readonly');
  vi.stubGlobal('ResizeObserver', vi.fn(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  })));
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  vi.unstubAllGlobals();
});

test('non-admin users keep normal navigation while settings, Files and Source Control are hidden', async () => {
  renderPalette();
  openPalette();

  assert.ok(await screen.findByText('Go to Chat'));
  assert.equal(screen.queryByText('Go to Tasks'), null);
  assert.equal(screen.queryByText('Go to Files'), null);
  assert.equal(screen.queryByText('Go to Git'), null);
  assert.equal(screen.queryByText('Git: Fetch'), null);
  assert.equal(screen.queryByText('hidden.ts'), null);
  assert.equal(screen.queryByText('hidden commit'), null);
  assert.equal(screen.queryByText('Switch to: hidden-branch'), null);
  assert.equal(screen.queryByText('Open settings'), null);
  assert.equal(screen.queryByText(/^Settings:/), null);
  assert.equal(screen.queryByText('Go to Shell'), null);
});

test('the settings administrator sees both the shortcut and settings sections', async () => {
  authState.canManageSettings = true;
  deploymentState.isReadOnly = false;
  deploymentState.can.mockReturnValue(true);
  renderPalette();
  openPalette();

  assert.ok(await screen.findByText('Go to Chat'));
  assert.ok(screen.getByText('Open settings'));
  assert.ok(screen.getAllByText(/^Settings:/).length > 0);
  assert.equal(screen.queryByText('Go to Tasks'), null);
  assert.equal(screen.queryByText('Settings: Tasks'), null);
  assert.ok(screen.getByText('Go to Shell'));
});

test('read-only deployments hide Shell even when a stale execution capability is present', async () => {
  deploymentState.isReadOnly = true;
  deploymentState.can.mockReturnValue(true);

  renderPalette();
  openPalette();

  assert.ok(await screen.findByText('Go to Chat'));
  assert.equal(screen.queryByText('Go to Shell'), null);
});
