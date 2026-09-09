import assert from 'node:assert/strict';

import { test } from 'vitest';

import { isManagedIdentityRestricted } from '@/modules/auth/identityAccess';

test('pending and ambiguous managed actors are read-only even on a writable SSO profile', () => {
  for (const identityStatus of ['configured', 'pending', 'ambiguous'] as const) {
    assert.equal(
      isManagedIdentityRestricted('dingtalk', {
        actor: { provider: 'dingtalk', identityStatus, personId: 'person-1' },
      }),
      true,
      identityStatus,
    );
    assert.equal(
      isManagedIdentityRestricted('platform', {
        actor: { provider: 'dingtalk', identityStatus, personId: 'person-1' },
      }),
      true,
      identityStatus,
    );
  }
});

test('verified DingTalk identity is writable at the identity boundary', () => {
  assert.equal(
    isManagedIdentityRestricted('dingtalk', {
      actor: { provider: 'dingtalk', identityStatus: 'verified', personId: 'person-1' },
    }),
    false,
  );
  assert.equal(
    isManagedIdentityRestricted('platform', {
      actor: { provider: 'dingtalk', identityStatus: 'verified', personId: 'person-1' },
    }),
    false,
  );
});

test('local password developer sessions are not affected by a stale actor row', () => {
  assert.equal(
    isManagedIdentityRestricted('password', {
      actor: { provider: 'dingtalk', identityStatus: 'pending' },
    }),
    false,
  );
  assert.equal(isManagedIdentityRestricted(null, null), false);
});

test('explicit DingTalk mode fails closed when its actor payload is missing or malformed', () => {
  assert.equal(isManagedIdentityRestricted('dingtalk', null), true);
  assert.equal(
    isManagedIdentityRestricted('dingtalk', {
      actor: { provider: 'dingtalk', identityStatus: 'verified' },
    }),
    true,
  );
});
