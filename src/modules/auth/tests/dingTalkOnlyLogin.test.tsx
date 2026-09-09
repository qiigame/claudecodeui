import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import LoginForm from '@/modules/auth/LoginForm';

const authState = vi.hoisted(() => ({
  dingTalkProviders: [] as Array<{ key: string; name: string }>,
  error: null as string | null,
  login: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/modules/auth/context/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/shared/api', () => ({
  api: {
    auth: {
      dingTalkStartUrl: (provider: string, returnTo: string) =>
        `/api/auth/dingtalk/start?provider=${provider}&returnTo=${encodeURIComponent(returnTo)}`,
    },
  },
}));

beforeEach(() => {
  authState.dingTalkProviders = [];
  authState.error = null;
  authState.login.mockReset();
});

test('shows only DingTalk choices when DingTalk login is configured', () => {
  authState.dingTalkProviders = [
    { key: 'company-a', name: '公司 A' },
    { key: 'company-b', name: '公司 B' },
  ];

  render(<LoginForm />);

  assert.equal(screen.getAllByRole('link', { name: /钉钉登录/ }).length, 2);
  assert.equal(screen.queryByText('或使用本地账号'), null);
  assert.equal(screen.queryByLabelText('login.username'), null);
  assert.equal(screen.queryByLabelText('login.password'), null);
  assert.equal(screen.queryByRole('button', { name: 'login.submit' }), null);
});

test('keeps the local form as a fallback when DingTalk is not configured', () => {
  render(<LoginForm />);

  assert.ok(screen.getByLabelText('login.username'));
  assert.ok(screen.getByLabelText('login.password'));
  assert.ok(screen.getByRole('button', { name: 'login.submit' }));
});
