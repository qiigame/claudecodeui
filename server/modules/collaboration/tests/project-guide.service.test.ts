import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getProjectGuide } from '@/modules/collaboration/project-guide.service.js';

async function withProjectDirectory(
  run: (projectDirectory: string, parentDirectory: string) => Promise<void>,
): Promise<void> {
  const parentDirectory = await mkdtemp(path.join(tmpdir(), 'cloudcli-guide-'));
  const projectDirectory = path.join(parentDirectory, 'project');
  await mkdir(projectDirectory);
  try {
    await run(projectDirectory, parentDirectory);
  } finally {
    await rm(parentDirectory, { recursive: true, force: true });
  }
}

function projectLookup(projectDirectory: string) {
  return {
    getProjectById: () => ({
      project_id: 'project-1',
      project_path: projectDirectory,
      custom_project_name: 'Comic Workspace',
      isStarred: 0,
      isArchived: 0,
    }),
  };
}

test('project guide reads only fixed root documents in deterministic order', async () => {
  await withProjectDirectory(async (projectDirectory) => {
    await writeFile(path.join(projectDirectory, 'README.md'), '# Read me', 'utf8');
    await writeFile(path.join(projectDirectory, 'AGENTS.md'), '# Agents', 'utf8');
    await mkdir(path.join(projectDirectory, 'nested'));
    await writeFile(path.join(projectDirectory, 'nested', 'CLAUDE.md'), 'not root', 'utf8');
    await writeFile(path.join(projectDirectory, 'secrets.txt'), 'must not be returned', 'utf8');

    const result = await getProjectGuide('project-1', projectLookup(projectDirectory));

    assert.equal(result.projectName, 'Comic Workspace');
    assert.deepEqual(result.documents.map((document) => document.name), ['README.md', 'AGENTS.md']);
    assert.deepEqual(result.documents.map((document) => document.content), ['# Read me', '# Agents']);
    assert.equal(JSON.stringify(result).includes(projectDirectory), false);
    assert.equal(JSON.stringify(result).includes('must not be returned'), false);
  });
});

test('project guide never follows a project-root symlink outside the project', async () => {
  await withProjectDirectory(async (projectDirectory, parentDirectory) => {
    const outsideFile = path.join(parentDirectory, 'outside.md');
    await writeFile(outsideFile, 'outside secret', 'utf8');
    await symlink(outsideFile, path.join(projectDirectory, 'README.md'));
    await writeFile(path.join(projectDirectory, 'CLAUDE.md'), 'safe instructions', 'utf8');

    const result = await getProjectGuide('project-1', projectLookup(projectDirectory));

    assert.deepEqual(result.documents.map((document) => document.name), ['CLAUDE.md']);
    assert.equal(JSON.stringify(result).includes('outside secret'), false);
  });
});

test('project guide omits oversized files rather than reading them into memory', async () => {
  await withProjectDirectory(async (projectDirectory) => {
    await writeFile(path.join(projectDirectory, 'README.md'), Buffer.alloc(1024 * 1024 + 1, 65));

    const result = await getProjectGuide('project-1', projectLookup(projectDirectory));

    assert.deepEqual(result.documents, []);
  });
});
