import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveClaudeConfigDirectory,
  resolveCodexConfigPath,
  resolveCodexHomeDirectory,
} from '@/shared/utils.js';

test('resolveCodexConfigPath gives the CC-Switch override precedence', () => {
  assert.equal(
    resolveCodexConfigPath(
      { COMIC_CC_SWITCH_CODEX_CONFIG_PATH: './cc-switch/config.toml', COMIC_CODEX_HOME: '/ignored' },
      '/tmp/cloudcli-home',
    ),
    path.resolve('cc-switch/config.toml'),
  );
  assert.equal(
    resolveCodexConfigPath({ COMIC_CODEX_HOME: '/var/lib/cloudcli/codex' }, '/tmp/cloudcli-home'),
    '/var/lib/cloudcli/codex/config.toml',
  );
});

test('resolveCodexHomeDirectory prefers the app override and normalizes it', () => {
  assert.equal(
    resolveCodexHomeDirectory(
      { COMIC_CODEX_HOME: './candidate-codex', CODEX_HOME: '/ignored' },
      '/tmp/cloudcli-home',
    ),
    path.resolve('candidate-codex'),
  );
});

test('resolveCodexHomeDirectory honors CODEX_HOME and preserves the legacy fallback', () => {
  assert.equal(
    resolveCodexHomeDirectory({ CODEX_HOME: '/var/lib/cloudcli/codex' }, '/tmp/cloudcli-home'),
    '/var/lib/cloudcli/codex',
  );
  assert.equal(
    resolveCodexHomeDirectory({}, '/tmp/cloudcli-home'),
    '/tmp/cloudcli-home/.codex',
  );
  assert.equal(
    resolveCodexHomeDirectory({ CODEX_HOME: '   ' }, '/tmp/cloudcli-home'),
    '/tmp/cloudcli-home/.codex',
  );
});

test('resolveClaudeConfigDirectory gives the app-specific root precedence', () => {
  assert.equal(
    resolveClaudeConfigDirectory(
      { COMIC_CLAUDE_CONFIG_DIR: './candidate-claude', CLAUDE_CONFIG_DIR: '/ignored' },
      '/tmp/cloudcli-home',
    ),
    path.resolve('candidate-claude'),
  );
  assert.equal(
    resolveClaudeConfigDirectory({ CLAUDE_CONFIG_DIR: '/var/lib/cloudcli/claude' }, '/tmp/cloudcli-home'),
    '/var/lib/cloudcli/claude',
  );
  assert.equal(
    resolveClaudeConfigDirectory({}, '/tmp/cloudcli-home'),
    '/tmp/cloudcli-home/.claude',
  );
});

test('resolver defaults continue to follow the process home directory', () => {
  assert.equal(
    resolveCodexHomeDirectory({}, os.homedir()),
    path.join(os.homedir(), '.codex'),
  );
  assert.equal(
    resolveClaudeConfigDirectory({}, os.homedir()),
    path.join(os.homedir(), '.claude'),
  );
});
