import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { test, vi } from 'vitest';

import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [] }),
  PluginIcon: () => null,
}));

vi.mock('@/shared/ui', () => ({
  PillBar: ({ children, ...props }: ComponentPropsWithoutRef<'div'>) => (
    <div {...props}>{children}</div>
  ),
  Pill: ({ children, isActive: _isActive, ...props }: ComponentPropsWithoutRef<'button'> & { isActive: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

test('the shared desktop and mobile tab strip hides Files and Source Control but keeps Browser', () => {
  render(
    <WorkspaceTabs
      activeTab="chat"
      setActiveTab={() => undefined}
      shouldShowTasksTab
      shouldShowBrowserTab
      canReadBrowser={true}
    />,
  );

  assert.ok(screen.getByRole('tab', { name: 'tabs.chat' }));
  assert.ok(screen.getByRole('tab', { name: 'tabs.browser' }));
  assert.equal(screen.queryByRole('tab', { name: 'tabs.files' }), null);
  assert.equal(screen.queryByRole('tab', { name: 'tabs.git' }), null);
});
