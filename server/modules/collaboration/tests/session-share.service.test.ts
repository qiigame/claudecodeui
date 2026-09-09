import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionShareSnapshot } from '@/modules/collaboration/session-share.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

const message = (overrides: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'message-1',
  sessionId: 'session-1',
  timestamp: '2026-09-01T00:00:00.000Z',
  provider: 'codex',
  kind: 'text',
  role: 'assistant',
  content: 'Visible answer',
  ...overrides,
});

test('public snapshot whitelists visible text and drops tool, reasoning and attachment fields', () => {
  const snapshot = buildSessionShareSnapshot(
    {
      provider: 'codex',
      summary: 'Recommendation work',
      createdAt: '2026-09-01T00:00:00.000Z',
      project: { displayName: 'Comic App' },
    },
    {
      hasMore: false,
      messages: [
        message({ id: 'user', role: 'user', content: 'Please review this.' }),
        message({ id: 'thinking', kind: 'thinking', content: 'Hidden reasoning' }),
        message({ id: 'tool', kind: 'tool_use', toolName: 'exec', toolInput: { token: 'secret' } }),
        message({ id: 'assistant', content: 'Done.', files: [{ path: '/private/file' }] }),
      ],
    },
    '2026-09-01T01:00:00.000Z',
  );

  assert.deepEqual(snapshot.messages, [
    {
      role: 'user',
      content: 'Please review this.',
      timestamp: '2026-09-01T00:00:00.000Z',
    },
    {
      role: 'assistant',
      content: 'Done.',
      timestamp: '2026-09-01T00:00:00.000Z',
    },
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('Hidden reasoning'), false);
  assert.equal(serialized.includes('/private/file'), false);
  assert.equal(serialized.includes('toolInput'), false);
});

test('public snapshot redacts common credentials and home-directory identities', () => {
  const snapshot = buildSessionShareSnapshot(
    {
      provider: 'claude',
      summary: 'api_key=top-secret',
      createdAt: null,
      project: { displayName: 'Workspace' },
    },
    {
      hasMore: false,
      messages: [message({
        role: 'user',
        content: 'Authorization: Bearer abcdefghijklmnop\nPath: /Users/alice/private/repo\naccess_token=abcdef123456',
      })],
    },
    '2026-09-01T01:00:00.000Z',
  );

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('abcdefghijklmnop'), false);
  assert.equal(serialized.includes('abcdef123456'), false);
  assert.equal(serialized.includes('/Users/alice'), false);
  assert.match(serialized, /REDACTED/);
});
