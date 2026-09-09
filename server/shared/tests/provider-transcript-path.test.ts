import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeProjectDirectoryName,
  openValidatedProviderTranscript,
  validateProviderTranscriptPath,
} from '@/shared/utils.js';

async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('provider transcript validator accepts canonical Claude and Codex files', async () => {
  const root = await makeRoot('provider-transcript-valid-');
  try {
    const claudeCwd = '/workspace';
    const claudeProjectDirectory = buildClaudeProjectDirectoryName(claudeCwd, {
      CLAUDE_CONFIG_DIR: path.dirname(root),
    });
    assert.ok(claudeProjectDirectory);
    const claudeFile = path.join(root, claudeProjectDirectory, 'claude-id.jsonl');
    const codexFile = path.join(root, 'codex', 'rollout-codex-id.jsonl');
    const codexSubagentFile = path.join(root, 'codex', 'rollout-codex-subagent-id.jsonl');
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await mkdir(path.dirname(codexFile), { recursive: true });
    await writeFile(claudeFile, `${JSON.stringify({ sessionId: 'claude-id', cwd: claudeCwd })}\n`);
    await writeFile(codexFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-id', thread_source: 'user' },
    })}\n`);
    await writeFile(codexSubagentFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-subagent-id', thread_source: 'subagent' },
    })}\n`);

    assert.equal(
      await validateProviderTranscriptPath({
        provider: 'claude',
        candidatePath: claudeFile,
        rootPath: root,
        providerSessionId: 'claude-id',
      }),
      await realpath(claudeFile),
    );
    assert.equal(
      await validateProviderTranscriptPath({
        provider: 'codex',
        candidatePath: codexFile,
        rootPath: root,
        providerSessionId: 'codex-id',
      }),
      await realpath(codexFile),
    );
    assert.equal(
      await validateProviderTranscriptPath({
        provider: 'codex',
        candidatePath: codexSubagentFile,
        rootPath: root,
        providerSessionId: 'codex-subagent-id',
        expectedSubagent: true,
      }),
      await realpath(codexSubagentFile),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authenticated transcript descriptor remains bound when its pathname is replaced', async () => {
  const root = await makeRoot('provider-transcript-descriptor-');
  try {
    const cwd = path.join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const projectDirectory = buildClaudeProjectDirectoryName(cwd, {});
    assert.ok(projectDirectory);
    await mkdir(path.join(root, projectDirectory), { recursive: true });

    const transcriptPath = path.join(root, projectDirectory, 'descriptor-id.jsonl');
    const original = `${JSON.stringify({ sessionId: 'descriptor-id', cwd })}\n`;
    await writeFile(transcriptPath, original);

    const authenticated = await openValidatedProviderTranscript({
      provider: 'claude',
      candidatePath: transcriptPath,
      rootPath: root,
      providerSessionId: 'descriptor-id',
      expectedProjectPath: cwd,
    });
    assert.ok(authenticated);

    const movedPath = `${transcriptPath}.moved`;
    await rename(transcriptPath, movedPath);
    await writeFile(transcriptPath, `${JSON.stringify({
      sessionId: 'descriptor-id',
      cwd: '/foreign-workspace',
    })}\n`);

    // The descriptor still refers to the authenticated inode, while a fresh
    // pathname open would now observe the replacement file.
    assert.equal(await authenticated.handle.readFile({ encoding: 'utf8' }), original);
    await authenticated.handle.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a configured root alias accepts indexed canonical paths but rejects child symlinks', async () => {
  const root = await makeRoot('provider-transcript-root-alias-');
  try {
    const canonicalRoot = await realpath(root);
    const storageRoot = path.join(canonicalRoot, 'storage');
    const configuredRoot = path.join(canonicalRoot, 'configured-root');
    await mkdir(storageRoot);
    await symlink(storageRoot, configuredRoot);
    for (const provider of ['claude', 'codex'] as const) {
      const cwd = canonicalRoot;
      const directory = provider === 'claude' ? buildClaudeProjectDirectoryName(cwd, {})! : '2026';
      const parent = path.join(storageRoot, directory);
      await mkdir(parent, { recursive: true });
      const transcriptPath = path.join(parent, `${provider}-id.jsonl`);
      const record = provider === 'claude'
        ? { sessionId: `${provider}-id`, cwd }
        : { type: 'session_meta', payload: { id: `${provider}-id`, cwd } };
      await writeFile(transcriptPath, `${JSON.stringify(record)}\n`);
      const input = { provider, rootPath: configuredRoot, providerSessionId: `${provider}-id`, expectedProjectPath: cwd };
      assert.equal(await validateProviderTranscriptPath({ ...input, candidatePath: transcriptPath }), transcriptPath);
      assert.equal(await validateProviderTranscriptPath({ ...input, candidatePath: path.join(configuredRoot, directory, `${provider}-id.jsonl`) }), transcriptPath);
      const childAlias = path.join(storageRoot, `${provider}-alias`);
      await symlink(parent, childAlias);
      assert.equal(await validateProviderTranscriptPath({ ...input, candidatePath: path.join(childAlias, `${provider}-id.jsonl`) }), null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider transcript validator rejects escaped, symlinked, and non-file candidates', async () => {
  const root = await makeRoot('provider-transcript-boundary-');
  const outside = await makeRoot('provider-transcript-outside-');
  try {
    const primaryCwd = path.join(root, 'workspace-primary');
    const targetCwd = path.join(root, 'workspace-target');
    const primaryProject = buildClaudeProjectDirectoryName(primaryCwd, {});
    const targetProject = buildClaudeProjectDirectoryName(targetCwd, {});
    assert.ok(primaryProject);
    assert.ok(targetProject);

    const primaryDirectory = path.join(root, primaryProject);
    const targetDirectory = path.join(root, targetProject);
    const outsideDirectory = path.join(outside, 'foreign-project');
    await mkdir(primaryDirectory, { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    await mkdir(primaryCwd, { recursive: true });
    await mkdir(targetCwd, { recursive: true });

    const outsideFile = path.join(outsideDirectory, 'outside-id.jsonl');
    const linkedOutsideFile = path.join(primaryDirectory, 'outside-id.jsonl');
    const insideTargetFile = path.join(targetDirectory, 'inside-link-id.jsonl');
    const linkedInsideFile = path.join(primaryDirectory, 'inside-link-id.jsonl');
    const linkedParent = path.join(root, 'linked-parent');
    const parentEscapedFile = path.join(linkedParent, 'parent-id.jsonl');
    const internalCwd = path.join(root, 'workspace-internal');
    const internalProject = buildClaudeProjectDirectoryName(internalCwd, {});
    assert.ok(internalProject);
    const internalTargetDirectory = path.join(root, internalProject);
    const internalTargetFile = path.join(internalTargetDirectory, 'internal-parent-id.jsonl');
    const linkedInternalParent = path.join(root, 'linked-internal-parent');
    const parentInternalFile = path.join(linkedInternalParent, 'internal-parent-id.jsonl');
    const directory = path.join(primaryDirectory, 'directory-id.jsonl');

    await mkdir(internalTargetDirectory, { recursive: true });
    await mkdir(internalCwd, { recursive: true });
    await writeFile(outsideFile, `${JSON.stringify({
      sessionId: 'outside-id',
      cwd: '/foreign-workspace',
    })}\n`);
    await writeFile(insideTargetFile, `${JSON.stringify({
      sessionId: 'inside-link-id',
      cwd: targetCwd,
    })}\n`);
    await writeFile(internalTargetFile, `${JSON.stringify({
      sessionId: 'internal-parent-id',
      cwd: internalCwd,
    })}\n`);
    await symlink(outsideFile, linkedOutsideFile);
    await symlink(insideTargetFile, linkedInsideFile);
    await symlink(outside, linkedParent);
    await symlink(internalTargetDirectory, linkedInternalParent);
    await mkdir(directory);

    const validateClaude = (candidatePath: string, providerSessionId: string) => (
      validateProviderTranscriptPath({
        provider: 'claude',
        candidatePath,
        rootPath: root,
        providerSessionId,
      })
    );
    assert.equal(await validateClaude(outsideFile, 'outside-id'), null);
    assert.equal(await validateClaude(linkedOutsideFile, 'outside-id'), null);
    // A final symlink is rejected even when its target remains under the
    // configured root; containment alone would not prove this invariant.
    assert.equal(await validateClaude(linkedInsideFile, 'inside-link-id'), null);
    assert.equal(await validateClaude(parentEscapedFile, 'parent-id'), null);
    // Parent symlinks are rejected even when they currently resolve back into
    // the configured root, so retargeting cannot change the trust boundary.
    assert.equal(await validateClaude(parentInternalFile, 'internal-parent-id'), null);
    assert.equal(await validateClaude(directory, 'directory-id'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('provider transcript validator rejects provider-id and Codex thread-kind mismatches', async () => {
  const root = await makeRoot('provider-transcript-metadata-');
  try {
    const claudeCwd = path.join(root, 'workspace');
    const claudeProject = buildClaudeProjectDirectoryName(claudeCwd, {});
    assert.ok(claudeProject);
    await mkdir(path.join(root, claudeProject), { recursive: true });
    await mkdir(claudeCwd, { recursive: true });

    // Filenames deliberately match the requested id. Each rejection below
    // therefore reaches the metadata/thread-kind condition under test.
    const claudeFile = path.join(root, claudeProject, 'claude-id.jsonl');
    const codexWrongIdFile = path.join(root, 'codex-id.jsonl');
    const codexSubagentFile = path.join(root, 'rollout-20240101-codex-id.jsonl');
    const codexUserFile = path.join(root, 'rollout-20240102-codex-id.jsonl');
    await writeFile(claudeFile, `${JSON.stringify({
      sessionId: 'different-id',
      cwd: claudeCwd,
    })}\n`);
    await writeFile(codexWrongIdFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'different-codex-id', thread_source: 'user' },
    })}\n`);
    await writeFile(codexSubagentFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-id', thread_source: 'subagent' },
    })}\n`);
    await writeFile(codexUserFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-id', thread_source: 'user' },
    })}\n`);

    assert.equal(await validateProviderTranscriptPath({
      provider: 'claude',
      candidatePath: claudeFile,
      rootPath: root,
      providerSessionId: 'claude-id',
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'codex',
      candidatePath: codexWrongIdFile,
      rootPath: root,
      providerSessionId: 'codex-id',
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'codex',
      candidatePath: codexSubagentFile,
      rootPath: root,
      providerSessionId: 'codex-id',
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'codex',
      candidatePath: codexUserFile,
      rootPath: root,
      providerSessionId: 'codex-id',
      expectedSubagent: true,
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider transcript validator binds the opening cwd to the effective session runtime path', async () => {
  const root = await makeRoot('provider-transcript-runtime-cwd-');
  try {
    const sourceCwd = path.join(root, 'source-checkout');
    const runtimeCwd = path.join(root, 'private-runtime');
    await mkdir(sourceCwd, { recursive: true });
    await mkdir(runtimeCwd, { recursive: true });

    const claudeProject = buildClaudeProjectDirectoryName(sourceCwd, {});
    assert.ok(claudeProject);
    const claudeFile = path.join(root, claudeProject, 'isolated-claude.jsonl');
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await writeFile(claudeFile, `${JSON.stringify({
      sessionId: 'isolated-claude',
      cwd: sourceCwd,
    })}\n`);

    const codexFile = path.join(root, 'rollout-isolated-codex.jsonl');
    await writeFile(codexFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'isolated-codex', cwd: sourceCwd, thread_source: 'user' },
    })}\n`);

    assert.equal(await validateProviderTranscriptPath({
      provider: 'claude',
      candidatePath: claudeFile,
      rootPath: root,
      providerSessionId: 'isolated-claude',
      expectedProjectPath: runtimeCwd,
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'codex',
      candidatePath: codexFile,
      rootPath: root,
      providerSessionId: 'isolated-codex',
      expectedProjectPath: runtimeCwd,
    }), null);

    assert.equal(
      await validateProviderTranscriptPath({
        provider: 'claude',
        candidatePath: claudeFile,
        rootPath: root,
        providerSessionId: 'isolated-claude',
        expectedProjectPath: sourceCwd,
      }),
      await realpath(claudeFile),
    );
    assert.equal(
      await validateProviderTranscriptPath({
        provider: 'codex',
        candidatePath: codexFile,
        rootPath: root,
        providerSessionId: 'isolated-codex',
        expectedProjectPath: sourceCwd,
      }),
      await realpath(codexFile),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider transcript validator fails closed for missing or malformed metadata and bad ids', async () => {
  const root = await makeRoot('provider-transcript-invalid-metadata-');
  try {
    const claudeCwd = path.join(root, 'workspace');
    const claudeProject = buildClaudeProjectDirectoryName(claudeCwd, {});
    assert.ok(claudeProject);
    await mkdir(path.join(root, claudeProject), { recursive: true });
    await mkdir(claudeCwd, { recursive: true });

    const missingMetadataFile = path.join(root, 'codex-id.jsonl');
    const malformedFile = path.join(root, claudeProject, 'claude-id.jsonl');
    const wrongFirstEnvelopeFile = path.join(root, 'rollout-20240101-codex-id.jsonl');
    const validFile = path.join(root, claudeProject, 'claude-valid-id.jsonl');
    await writeFile(missingMetadataFile, `${JSON.stringify({
      type: 'event_msg',
      payload: { id: 'codex-id' },
    })}\n`);
    await writeFile(malformedFile, '{not-json}\n');
    await writeFile(wrongFirstEnvelopeFile, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: 'other-id', thread_source: 'user' } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-id', thread_source: 'user' } }),
    ].join('\n')}\n`);
    await writeFile(validFile, `${JSON.stringify({
      sessionId: 'claude-valid-id',
      cwd: claudeCwd,
    })}\n`);

    assert.equal(await validateProviderTranscriptPath({
      provider: 'codex',
      candidatePath: missingMetadataFile,
      rootPath: root,
      providerSessionId: 'codex-id',
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'claude',
      candidatePath: malformedFile,
      rootPath: root,
      providerSessionId: 'claude-id',
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'codex',
      candidatePath: wrongFirstEnvelopeFile,
      rootPath: root,
      providerSessionId: 'codex-id',
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'claude',
      candidatePath: validFile,
      rootPath: root,
      providerSessionId: 123 as unknown as string,
    }), null);
    assert.equal(await validateProviderTranscriptPath({
      provider: 'claude',
      candidatePath: validFile,
      rootPath: root,
      providerSessionId: '../claude-id',
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider transcript validator rejects Claude subagent and tool-result paths', async () => {
  const root = await makeRoot('provider-transcript-claude-internal-');
  try {
    const claudeCwd = path.join(root, 'workspace');
    const claudeProject = buildClaudeProjectDirectoryName(claudeCwd, {});
    assert.ok(claudeProject);
    const projectDirectory = path.join(root, claudeProject);
    const subagentFile = path.join(projectDirectory, 'subagents', 'agent-id.jsonl');
    const toolResultFile = path.join(projectDirectory, 'tool-results', 'result-id.jsonl');
    await mkdir(path.dirname(subagentFile), { recursive: true });
    await mkdir(path.dirname(toolResultFile), { recursive: true });
    await mkdir(claudeCwd, { recursive: true });
    const row = `${JSON.stringify({ sessionId: 'claude-id', cwd: claudeCwd })}\n`;
    await writeFile(subagentFile, row);
    await writeFile(toolResultFile, row);

    for (const [candidatePath, providerSessionId] of [
      [subagentFile, 'agent-id'],
      [toolResultFile, 'result-id'],
    ] as const) {
      assert.equal(await validateProviderTranscriptPath({
        provider: 'claude',
        candidatePath,
        rootPath: root,
        providerSessionId,
      }), null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
