import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';
import SidebarHeader from '@/modules/sidebar/SidebarHeader';

const authState = vi.hoisted(() => ({
  canManageSettings: false,
  authMode: null as 'dingtalk' | 'platform' | 'password' | null,
  user: null as { actor?: { provider?: string; identityStatus?: string; personId?: string } } | null,
}));
const deploymentState = vi.hoisted(() => ({
  isReadOnly: false,
  can: vi.fn(() => true),
}));

vi.mock('@/modules/auth', () => ({
  useAuth: () => authState,
  isManagedIdentityRestricted: () => false,
}));

vi.mock('@/shared/context/DeploymentPolicyContext', () => ({
  useDeploymentPolicy: () => deploymentState,
}));

const t = ((key: string) => key) as unknown as TFunction;
const noop = () => undefined;

beforeEach(() => {
  authState.canManageSettings = false;
  authState.authMode = null;
  authState.user = null;
  deploymentState.isReadOnly = false;
  deploymentState.can.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

test('product sidebar chrome omits upstream issue/community links and hides admin actions by default', () => {
  const { container } = render(
    <SidebarFooter
      updateAvailable
      restartRequired={false}
      releaseInfo={null}
      latestVersion="9.9.9"
      onShowVersionModal={noop}
      onShowSettings={noop}
      t={t}
    />,
  );

  assert.equal(screen.queryByText('actions.reportIssue'), null);
  assert.equal(screen.queryByText('actions.joinCommunity'), null);
  assert.equal(screen.queryByText('actions.settings'), null);
  assert.equal(screen.queryByText('version.updateAvailable'), null);
  assert.equal(container.querySelector('a[href*="issues"]'), null);
  assert.equal(container.querySelector('a[href*="discord"]'), null);
  assert.equal(container.querySelector('a[href*="github.com/siteboon/claudecodeui"]'), null);
  assert.equal(screen.queryByText(/CloudCLI v/), null);
  assert.equal(container.querySelector('.nav-divider'), null);
});

test('the authorized settings administrator sees settings and update actions', () => {
  authState.canManageSettings = true;

  render(
    <SidebarFooter
      updateAvailable
      restartRequired={false}
      releaseInfo={null}
      latestVersion="9.9.9"
      onShowVersionModal={noop}
      onShowSettings={noop}
      t={t}
    />,
  );

  assert.equal(screen.getAllByText('actions.settings').length, 2);
  assert.equal(screen.getAllByText('version.updateAvailable').length, 2);
});

test('a read-only deployment hides settings even when the auth identity is an administrator', () => {
  authState.canManageSettings = true;
  deploymentState.isReadOnly = true;
  deploymentState.can.mockReturnValue(false);

  render(
    <SidebarFooter
      updateAvailable
      restartRequired={false}
      releaseInfo={null}
      latestVersion="9.9.9"
      onShowVersionModal={noop}
      onShowSettings={noop}
      t={t}
    />,
  );

  assert.equal(screen.queryByText('actions.settings'), null);
  assert.equal(screen.queryByText('version.updateAvailable'), null);
});

test('collapsed sidebar follows the same fail-closed permission and has no community actions', () => {
  const { rerender } = render(
    <SidebarCollapsed
      onExpand={noop}
      onShowSettings={noop}
      updateAvailable
      restartRequired={false}
      onShowVersionModal={noop}
      t={t}
    />,
  );

  assert.equal(screen.queryByLabelText('actions.settings'), null);
  assert.equal(screen.queryByLabelText('actions.reportIssue'), null);
  assert.equal(screen.queryByLabelText('actions.joinCommunity'), null);
  assert.equal(screen.queryByLabelText('common:versionUpdate.ariaLabels.updateAvailable'), null);

  authState.canManageSettings = true;
  rerender(
    <SidebarCollapsed
      onExpand={noop}
      onShowSettings={noop}
      updateAvailable
      restartRequired={false}
      onShowVersionModal={noop}
      t={t}
    />,
  );

  assert.ok(screen.getByLabelText('actions.settings'));
  assert.ok(screen.getByLabelText('common:versionUpdate.ariaLabels.updateAvailable'));
});

test('sidebar header no longer renders the GitHub star badge', () => {
  const { container } = render(
    <SidebarHeader
      isPWA={false}
      isMobile={false}
      isLoading={false}
      projectsCount={0}
      runningSessionsCount={0}
      archivedSessionsCount={0}
      isArchivedSessionsLoading={false}
      searchFilter=""
      onSearchFilterChange={noop}
      onClearSearchFilter={noop}
      searchMode="projects"
      onSearchModeChange={noop}
      onRefresh={noop}
      isRefreshing={false}
      onCreateProject={noop}
      onCollapseSidebar={noop}
      t={t}
    />,
  );

  assert.equal(container.querySelector('a[href*="github.com/siteboon/claudecodeui"]'), null);
});

test('sidebar header hides project creation while a managed actor is pending', () => {
  authState.authMode = 'dingtalk';
  authState.user = {
    actor: { provider: 'dingtalk', identityStatus: 'pending', personId: 'pending-1' },
  };

  render(
    <SidebarHeader
      isPWA={false}
      isMobile={false}
      isLoading={false}
      projectsCount={0}
      runningSessionsCount={0}
      archivedSessionsCount={0}
      isArchivedSessionsLoading={false}
      searchFilter=""
      onSearchFilterChange={noop}
      onClearSearchFilter={noop}
      searchMode="projects"
      onSearchModeChange={noop}
      onRefresh={noop}
      isRefreshing={false}
      onCreateProject={noop}
      onCollapseSidebar={noop}
      t={t}
    />,
  );

  assert.equal(screen.queryByTitle('tooltips.createProject'), null);
});

test('sidebar header hides project creation when read-only wins over a stale project capability', () => {
  // A contradictory/stale capability payload must not reopen a project write
  // entry point while the deployment policy is explicitly read-only.
  deploymentState.isReadOnly = true;
  deploymentState.can.mockReturnValue(true);

  render(
    <SidebarHeader
      isPWA={false}
      isMobile={false}
      isLoading={false}
      projectsCount={0}
      runningSessionsCount={0}
      archivedSessionsCount={0}
      isArchivedSessionsLoading={false}
      searchFilter=""
      onSearchFilterChange={noop}
      onClearSearchFilter={noop}
      searchMode="projects"
      onSearchModeChange={noop}
      onRefresh={noop}
      isRefreshing={false}
      onCreateProject={noop}
      onCollapseSidebar={noop}
      t={t}
    />,
  );

  assert.equal(screen.queryByTitle('tooltips.createProject'), null);
});
