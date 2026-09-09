import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';

const ENVIRONMENT_KEYS = [
  'CLAUDE_CLI_PATH',
  'COMIC_CODEX_CLI_PATH',
  'COMIC_DATAVERSE_TOKEN_HELPER',
] as const;

async function withEnvironment(
  overrides: Partial<Record<(typeof ENVIRONMENT_KEYS)[number], string>>,
  operation: () => Promise<void>,
): Promise<void> {
  const previousValues: Partial<Record<(typeof ENVIRONMENT_KEYS)[number], string>> = {};
  for (const key of ENVIRONMENT_KEYS) {
    previousValues[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await operation();
  } finally {
    for (const key of ENVIRONMENT_KEYS) {
      const previousValue = previousValues[key];
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

test('installed Codex and Claude CLIs report the configured Dataverse helper without executing it', async () => {
  await withEnvironment({
    CLAUDE_CLI_PATH: process.execPath,
    COMIC_CODEX_CLI_PATH: process.execPath,
    COMIC_DATAVERSE_TOKEN_HELPER: '/path/that/status-polling-must-not-execute',
  }, async () => {
    const codexStatus = await new CodexProviderAuth().getStatus();
    const claudeStatus = await new ClaudeProviderAuth().getStatus();

    assert.deepEqual(codexStatus, {
      installed: true,
      provider: 'codex',
      authenticated: true,
      email: 'Dataverse Runtime',
      method: 'dataverse_helper',
    });
    assert.deepEqual(claudeStatus, {
      installed: true,
      provider: 'claude',
      authenticated: true,
      email: 'Dataverse Runtime',
      method: 'dataverse_helper',
    });
  });
});

test('Codex installation checks honor COMIC_CODEX_CLI_PATH before helper readiness', async () => {
  const missingCliPath = path.join(
    os.tmpdir(),
    `cloudcli-missing-codex-${process.pid}`,
  );

  await withEnvironment({
    COMIC_CODEX_CLI_PATH: missingCliPath,
    COMIC_DATAVERSE_TOKEN_HELPER: '/path/that-status-must-not-execute',
  }, async () => {
    const status = await new CodexProviderAuth().getStatus();

    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);
    assert.equal(status.method, null);
    assert.match(status.error ?? '', /not installed/i);
  });
});
