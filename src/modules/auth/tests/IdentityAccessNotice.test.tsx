import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import IdentityAccessNotice from '@/modules/auth/IdentityAccessNotice';

const authState = vi.hoisted(() => ({
  user: null as {
    id: number;
    username: string;
    actor?: { identityStatus?: string };
  } | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('@/modules/auth/context/AuthContext', () => ({
  useAuth: () => authState,
}));

beforeEach(() => {
  authState.user = null;
});

test('explains pending automatic attribution without blocking normal chat', () => {
  authState.user = {
    id: 7,
    username: '待登记成员',
    actor: { identityStatus: 'pending' },
  };

  render(<IdentityAccessNotice />);

  assert.ok(screen.getByRole('dialog', { name: '正在自动识别身份' }));
  assert.ok(screen.getByText('当前钉钉身份将在登录后自动匹配项目人员。'));
  assert.ok(screen.getByText(/不影响普通会话/));
  assert.ok(screen.getByText(/姓名已登记且不存在同名人员/));

  fireEvent.click(screen.getByRole('button', { name: '知道了' }));
  assert.equal(screen.queryByRole('dialog'), null);
});

test('uses a distinct explanation when a DingTalk identity is ambiguous', () => {
  authState.user = {
    id: 8,
    username: '同名成员',
    actor: { identityStatus: 'ambiguous' },
  };

  render(<IdentityAccessNotice />);

  assert.ok(screen.getByText(/匹配到多个项目成员/));
});

test('does not interrupt a verified or legacy actor', () => {
  authState.user = {
    id: 9,
    username: '已验证成员',
    actor: { identityStatus: 'verified' },
  };
  const { rerender } = render(<IdentityAccessNotice />);
  assert.equal(screen.queryByRole('dialog'), null);

  authState.user = {
    id: 10,
    username: '本地成员',
    actor: { identityStatus: 'legacy' },
  };
  rerender(<IdentityAccessNotice />);
  assert.equal(screen.queryByRole('dialog'), null);
});
