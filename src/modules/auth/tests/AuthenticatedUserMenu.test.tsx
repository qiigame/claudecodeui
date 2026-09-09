import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import AuthenticatedUserMenu from '@/modules/auth/AuthenticatedUserMenu';

const authState = vi.hoisted(() => ({
  user: { username: '赵井渝' } as {
    username: string;
    actor?: { identityStatus?: string };
  } | null,
  logout: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: () => '退出登录' }),
}));

vi.mock('@/modules/auth/context/AuthContext', () => ({
  useAuth: () => authState,
}));

beforeEach(() => {
  authState.user = { username: '赵井渝' };
  authState.logout.mockReset();
});

test('shows the authenticated DingTalk name and logs out from the top-right action', () => {
  render(<AuthenticatedUserMenu />);

  assert.ok(screen.getByText('赵井渝'));
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  assert.equal(authState.logout.mock.calls.length, 1);
});

test('does not render without an authenticated user', () => {
  authState.user = null;
  const { container } = render(<AuthenticatedUserMenu />);

  assert.equal(container.childElementCount, 0);
});

test('keeps an identity-registration badge visible after the explanatory dialog is dismissed', () => {
  authState.user = {
    username: '待登记成员',
    actor: { identityStatus: 'pending' },
  };

  render(<AuthenticatedUserMenu />);

  assert.ok(screen.getByText('待登记'));
  assert.ok(screen.getByLabelText(/身份待登记，只读/));
});
