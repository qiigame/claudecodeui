import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    taskMasterUiEnabled: false,
  };
});

const { default: SettingsSidebar } = await import('@/modules/settings/SettingsSidebar');

afterEach(cleanup);

test('a disabled TaskMaster build removes Tasks from desktop and mobile settings navigation', () => {
  render(<SettingsSidebar activeTab="agents" onChange={vi.fn()} />);

  assert.equal(screen.queryByText('mainTabs.tasks'), null);
  assert.ok(screen.getAllByText('mainTabs.agents').length > 0);
});
