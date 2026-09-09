import fs from 'node:fs';
import path from 'node:path';

import { getDatabasePath } from '@/modules/database/index.js';

const PREPARE_COMMIT_MESSAGE_HOOK = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  '',
  "if (process.env.CLOUDCLI_EXECUTION_RUN_ID === undefined) process.exit(0);",
  "if (process.env.CLOUDCLI_GIT_IDENTITY_READY !== '1') {",
  "  console.error('[CloudCLI] Commit blocked: no registered Git identity is available for this execution.');",
  '  process.exit(1);',
  '}',
  "if (process.env.CLOUDCLI_HUMAN_ACTOR_REQUIRED === '1' && !process.env.CLOUDCLI_PERSON_ID) {",
  "  console.error('[CloudCLI] Commit blocked: the DingTalk actor is not bound to a project person_id.');",
  '  process.exit(1);',
  '}',
  "if (process.env.CLOUDCLI_GIT_IDENTITY_SHARED === '1' && process.env.CLOUDCLI_IDENTITY_STATUS !== 'verified') {",
  "  console.error('[CloudCLI] Commit blocked: shared Git identity requires a verified project identity.');",
  '  process.exit(1);',
  '}',
  '',
  'const messagePath = process.argv[2];',
  "if (!messagePath) process.exit(0);",
  "const existing = fs.readFileSync(messagePath, 'utf8');",
  'const trailers = [',
  "  ['Human-Actor', process.env.CLOUDCLI_PERSON_ID],",
  "  ['CloudCLI-Actor-ID', process.env.CLOUDCLI_ACTOR_ID],",
  "  ['CloudCLI-Session-ID', process.env.CLOUDCLI_SESSION_ID],",
  "  ['CloudCLI-Run-ID', process.env.CLOUDCLI_EXECUTION_RUN_ID],",
  "  ['CloudCLI-Provider', process.env.CLOUDCLI_PROVIDER],",
  '].filter((entry) => entry[1]);',
  'for (const [key, value] of trailers) {',
  '  const match = existing.match(new RegExp(`^${key}:\\\\s*(.+?)\\\\s*$`, \'mi\'));',
  '  if (match && match[1] !== value) {',
  '    console.error(`[CloudCLI] Commit blocked: ${key} does not match the authenticated execution.`);',
  '    process.exit(1);',
  '  }',
  '}',
  'const missing = trailers.filter(([key]) => !new RegExp(`^${key}:`, \'mi\').test(existing));',
  'if (missing.length === 0) process.exit(0);',
  "const separator = existing.endsWith('\\n\\n') ? '' : existing.endsWith('\\n') ? '\\n' : '\\n\\n';",
  "const appended = missing.map(([key, value]) => `${key}: ${value}`).join('\\n');",
  "fs.writeFileSync(messagePath, `${existing}${separator}${appended}\\n`, 'utf8');",
  '',
].join('\n');

const POST_COMMIT_HOOK = [
  '#!/usr/bin/env node',
  "const { execFileSync } = require('node:child_process');",
  '',
  "if (!process.env.CLOUDCLI_COMMIT_RECEIPT_URL || !process.env.CLOUDCLI_COMMIT_RECEIPT_TOKEN) process.exit(0);",
  "const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();",
  '',
  'async function main() {',
  "  const repoPath = git(['rev-parse', '--show-toplevel']);",
  "  const commitSha = git(['rev-parse', 'HEAD']);",
  '  const response = await fetch(process.env.CLOUDCLI_COMMIT_RECEIPT_URL, {',
  "    method: 'POST',",
  '    headers: {',
  "      authorization: `Bearer ${process.env.CLOUDCLI_COMMIT_RECEIPT_TOKEN}`,",
  "      'content-type': 'application/json',",
  '    },',
  '    body: JSON.stringify({',
  '      runId: process.env.CLOUDCLI_EXECUTION_RUN_ID,',
  '      repoPath,',
  '      commitSha,',
  '    }),',
  '  });',
  '  if (!response.ok) {',
  '    const body = await response.text();',
  "    throw new Error(`receipt endpoint returned ${response.status}: ${body.slice(0, 300)}`);",
  '  }',
  '}',
  '',
  'void main().catch((error) => {',
  "  console.error(`[CloudCLI] Commit created, but its attribution receipt failed: ${error.message}`);",
  '  process.exitCode = 1;',
  '});',
  '',
].join('\n');

function writeExecutableIfChanged(filePath: string, content: string): void {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) {
      fs.chmodSync(filePath, 0o700);
      return;
    }
  } catch {
    // A missing or unreadable hook is replaced atomically below.
  }

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o700 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o700);
}

/**
 * Used by the execution-attribution service to provision the isolated Git
 * hooks directory passed to provider and terminal child processes.
 */
export function ensureCommitAttributionHooks(): string {
  const hooksDirectory = path.join(path.dirname(getDatabasePath()), 'git-attribution-hooks');
  fs.mkdirSync(hooksDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(hooksDirectory, 0o700);
  writeExecutableIfChanged(
    path.join(hooksDirectory, 'prepare-commit-msg'),
    PREPARE_COMMIT_MESSAGE_HOOK,
  );
  writeExecutableIfChanged(path.join(hooksDirectory, 'post-commit'), POST_COMMIT_HOOK);
  return hooksDirectory;
}
