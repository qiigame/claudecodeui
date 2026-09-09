import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';

const deploymentState = {
  isReadOnly: true,
  can: vi.fn((capability: string) => capability === 'git.read' || capability === 'file.read'),
};

vi.mock('@/modules/auth', () => ({
  isManagedIdentityRestricted: () => false,
  useAuth: () => ({
    authMode: 'password',
    user: { username: 'qa-user' },
    canManageSettings: false,
  }),
}));

vi.mock('@/shared/context/DeploymentPolicyContext', () => ({
  useDeploymentPolicy: () => deploymentState,
}));

vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({
    showRawParameters: false,
    showThinking: false,
    sendByCtrlEnter: false,
  }),
}));

vi.mock('@/modules/project-workspace/WorkspaceHeader', () => ({
  default: (props: { canReadGit: boolean }) => (
    <div data-testid="workspace-header" data-can-read-git={String(props.canReadGit)} />
  ),
}));

vi.mock('@/modules/project-workspace/WorkspaceStateView', () => ({
  default: () => <div data-testid="workspace-state" />,
}));

vi.mock('@/modules/project-workspace/WorkspaceErrorBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/modules/chat', () => ({
  ChatInterface: () => <div data-testid="chat-interface" />,
}));

vi.mock('@/modules/file-tree', () => ({
  FileTree: () => <div data-testid="file-tree" />,
}));

vi.mock('@/modules/standalone-shell', () => ({
  StandaloneShell: () => <div data-testid="shell" />,
}));

vi.mock('@/modules/git-panel', () => ({
  GitPanel: () => <div data-testid="git-panel" />,
}));

vi.mock('@/modules/plugins', () => ({
  PluginTabContent: () => <div data-testid="plugin" />,
}));

vi.mock('@/modules/browser-use', () => ({
  BrowserUsePanel: () => <div data-testid="browser" />,
  useBrowserUseEnabled: () => false,
}));

vi.mock('@/modules/command-palette', () => ({
  usePaletteOpsRegister: () => undefined,
}));

vi.mock('@/modules/task-master', () => ({
  TaskMasterPanel: () => <div data-testid="tasks" />,
  useTaskMasterProjectSync: () => undefined,
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));

vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({
  useFileOpenResolver: () => () => undefined,
}));

vi.mock('@/modules/code-editor', () => ({
  EditorSidebar: () => <div data-testid="editor" />,
  useEditorSidebar: () => ({
    editingFile: null,
    editorWidth: 400,
    editorExpanded: false,
    hasManualWidth: false,
    resizeHandleRef: { current: null },
    handleFileOpen: () => undefined,
    handleCloseEditor: () => undefined,
    handleToggleEditorExpand: () => undefined,
    handleResizeStart: () => undefined,
  }),
}));

vi.mock('@/modules/collaboration', () => ({
  ProjectGuide: () => <div data-testid="guide" />,
}));

beforeEach(() => {
  deploymentState.isReadOnly = true;
  deploymentState.can.mockClear();
  deploymentState.can.mockImplementation((capability: string) => (
    capability === 'git.read' || capability === 'file.read'
  ));
});

test('hides the Git capability from workspace chrome in a read-only deployment', () => {
  render(
    <WorkspaceMain
      selectedProject={{
        projectId: 'project-1',
        path: '/tmp/project-1',
        fullPath: '/tmp/project-1',
        displayName: 'Project 1',
      } as never}
      selectedSession={null}
      activeTab="chat"
      setActiveTab={() => undefined}
      ws={null}
      sendMessage={() => undefined}
      isMobile={false}
      onMenuClick={() => undefined}
      isLoading={false}
      onNavigateToSession={() => undefined}
      onSessionEstablished={() => undefined}
      onShowSettings={() => undefined}
      externalMessageUpdate={0}
      newSessionTrigger={0}
      onProjectSelect={() => undefined}
      onProjectsRefresh={() => undefined}
    />,
  );

  assert.equal(screen.getByTestId('workspace-header').getAttribute('data-can-read-git'), 'false');
  assert.equal(screen.queryByTestId('git-panel'), null);
});
