import assert from 'node:assert/strict';
import test from 'node:test';

import { cursorRuntime } from './cursor-runtime.provider.js';

test('spawnCursor rejects readonly execution before resolving or spawning', async () => {
  let contextCalled = false;
  const context = {
    resolveProviderSessionId: () => {
      contextCalled = true;
      return null;
    },
    resolveResumeModel: async () => {
      contextCalled = true;
      return undefined;
    },
  };

  await assert.rejects(
    () => cursorRuntime.run(
      'must not execute',
      { deploymentReadOnly: true },
      { send() {}, setSessionId() {} },
      context,
    ),
    (error) => error?.code === 'PROVIDER_READ_ONLY_UNSUPPORTED'
      && error?.message === 'Provider "cursor" does not expose a safe read-only runtime in this deployment.',
  );
  assert.equal(contextCalled, false);
});
