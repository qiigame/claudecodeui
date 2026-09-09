import { constants as fsConstants, type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const GUIDE_FILE_NAMES = [
  'PROJECT_GUIDE.md',
  'README.md',
  'README',
  'READ.ME',
  'AGENTS.md',
  'CLAUDE.md',
] as const;
const MAX_GUIDE_FILE_BYTES = 1024 * 1024;

type ProjectGuideDocument = {
  name: string;
  title: string;
  content: string;
  size: number;
  updatedAt: string;
};

type ProjectGuideDependencies = {
  getProjectById: typeof projectsDb.getProjectById;
};

const DEFAULT_DEPENDENCIES: ProjectGuideDependencies = {
  getProjectById: (projectId) => projectsDb.getProjectById(projectId),
};

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function documentTitle(fileName: string): string {
  const normalizedName = fileName.toLowerCase();
  if (normalizedName === 'agents.md') return 'Agent Instructions';
  if (normalizedName === 'claude.md') return 'Claude Instructions';
  if (normalizedName === 'project_guide.md') return 'Project Guide';
  return 'README';
}

async function readGuideDocument(
  canonicalRoot: string,
  fileName: string,
): Promise<ProjectGuideDocument | null> {
  try {
    const requestedPath = path.join(canonicalRoot, fileName);
    const canonicalPath = await fsp.realpath(requestedPath);
    if (!isPathWithinRoot(canonicalRoot, canonicalPath)) {
      return null;
    }

    // Opening the resolved path with O_NOFOLLOW prevents a final-component
    // symlink swap between realpath() and readFile().
    const fileHandle = await fsp.open(
      canonicalPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const fileStats = await fileHandle.stat();
      if (!fileStats.isFile() || fileStats.size > MAX_GUIDE_FILE_BYTES) {
        return null;
      }

      const content = await fileHandle.readFile('utf8');
      if (content.includes('\0')) {
        return null;
      }

      return {
        name: fileName,
        title: documentTitle(fileName),
        content,
        size: fileStats.size,
        updatedAt: fileStats.mtime.toISOString(),
      };
    } finally {
      await fileHandle.close();
    }
  } catch {
    // A guide is optional. Files that disappear, cannot be read, or fail the
    // no-follow open are omitted without exposing server filesystem details.
    return null;
  }
}

/** Used by Collaboration routes to load fixed project-root documentation without accepting a filesystem path from the client. */
export async function getProjectGuide(
  projectId: string,
  dependencies: ProjectGuideDependencies = DEFAULT_DEPENDENCIES,
): Promise<{
  projectId: string;
  projectName: string;
  documents: ProjectGuideDocument[];
}> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    throw new AppError('projectId is required.', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const project = dependencies.getProjectById(normalizedProjectId);
  if (!project) {
    throw new AppError('Project was not found.', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  let canonicalRoot: string;
  let directoryEntries: Dirent[];
  try {
    canonicalRoot = await fsp.realpath(project.project_path);
    directoryEntries = await fsp.readdir(canonicalRoot, { withFileTypes: true });
  } catch {
    throw new AppError('Project directory is unavailable.', {
      code: 'PROJECT_DIRECTORY_UNAVAILABLE',
      statusCode: 404,
    });
  }

  const namesByLowerCase = new Map<string, string>();
  for (const entry of directoryEntries) {
    if (entry.isFile() || entry.isSymbolicLink()) {
      namesByLowerCase.set(entry.name.toLowerCase(), entry.name);
    }
  }

  const selectedNames: string[] = [];
  for (const preferredName of GUIDE_FILE_NAMES) {
    const actualName = namesByLowerCase.get(preferredName.toLowerCase());
    if (actualName && !selectedNames.includes(actualName)) {
      selectedNames.push(actualName);
    }
  }

  const documents = (
    await Promise.all(selectedNames.map((fileName) => readGuideDocument(canonicalRoot, fileName)))
  ).filter((document): document is ProjectGuideDocument => document !== null);

  const customName = project.custom_project_name?.trim();
  return {
    projectId: project.project_id,
    projectName: customName || path.basename(canonicalRoot) || 'Project',
    documents,
  };
}
