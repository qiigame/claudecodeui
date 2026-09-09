import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import SessionWorkspaceModal from '@/modules/chat/modals/SessionWorkspaceModal';
import type { SessionWorkspacePlan } from '@/shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

const plan: SessionWorkspacePlan = {
  enabled: true,
  requiresSelection: true,
  defaultRepositoryKeys: [],
  repositories: [
    {
      key: 'server',
      displayName: '服务端',
      relativePath: 'server',
      baseBranch: 'main',
      writable: true,
      unavailableReason: null,
    },
    {
      key: 'mirror',
      displayName: '只读镜像',
      relativePath: 'mirror',
      baseBranch: 'main',
      writable: false,
      unavailableReason: '只读',
    },
  ],
};

test('requires a writable repository choice and never enables read-only entries', () => {
  const onToggle = vi.fn();
  const onConfirm = vi.fn();
  const props = {
    plan,
    selectedKeys: [] as string[],
    onToggle,
    onConfirm,
    onClose: vi.fn(),
  };
  const { rerender } = render(<SessionWorkspaceModal {...props} />);

  const createButton = screen.getByRole('button', { name: '创建隔离会话' });
  expect((createButton as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('checkbox', { name: /只读镜像/ }) as HTMLInputElement).disabled).toBe(true);

  fireEvent.click(screen.getByRole('checkbox', { name: /服务端/ }));
  expect(onToggle).toHaveBeenCalledWith('server');

  rerender(<SessionWorkspaceModal {...props} selectedKeys={['server']} />);
  fireEvent.click(screen.getByRole('button', { name: '创建隔离会话' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
