import { randomUUID } from 'node:crypto';
import fs, { realpathSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import type {
  AnyRecord,
  ApiSuccessShape,
  AppErrorOptions,
  AuthenticatedWebSocketRequest,
  CodexMcpToolsApprovalMode,
  NormalizedMessage,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSkillSource,
  SubagentActivity,
  WorkspacePathValidationResult,
} from '@/shared/types.js';

//----------------- ENVIRONMENT UTILITIES ------------
/**
 * Indicates whether the backend is running in hosted Platform mode rather than
 * self-hosted OSS mode. The server bootstrap, Agent, Auth, and Browser Use
 * modules use this shared flag to keep environment-dependent behavior aligned.
 * Environment variables must be loaded before this module is evaluated.
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Resolves the Claude Code configuration root used by runtime persistence.
 *
 * The Claude provider's runtime bridge exposes the pilot-specific
 * `COMIC_CLAUDE_CONFIG_DIR` to Claude Code as `CLAUDE_CONFIG_DIR`. History
 * readers, synchronizers, and filesystem watchers use this helper so they
 * inspect that same root instead of silently falling back to `~/.claude`.
 * A directly configured `CLAUDE_CONFIG_DIR` is also respected for regular
 * self-hosted deployments; the traditional home-directory location remains
 * the final fallback.
 */
export function resolveClaudeConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configuredDirectory = environment.COMIC_CLAUDE_CONFIG_DIR?.trim()
    || environment.CLAUDE_CONFIG_DIR?.trim();

  return configuredDirectory
    ? path.resolve(configuredDirectory)
    : path.join(homeDirectory, '.claude');
}

/**
 * Resolves the Codex home used for runtime configuration and persistence.
 *
 * CloudCLI can host more than one agent instance on the same machine.  The
 * standard `CODEX_HOME` variable is therefore the source of truth for an
 * isolated Codex installation; `COMIC_CODEX_HOME` is an app-specific alias
 * that lets an operator keep the host's Codex configuration untouched while
 * still using the normal Codex variable inside child processes.  Resolution
 * happens on every call so tests and long-lived server processes can change
 * their environment before a new runtime turn without a stale module-level
 * path.
 */
export function resolveCodexHomeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configuredDirectory = environment.COMIC_CODEX_HOME?.trim()
    || environment.CODEX_HOME?.trim();

  return configuredDirectory
    ? path.resolve(configuredDirectory)
    : path.join(homeDirectory, '.codex');
}

/**
 * Resolves the Codex TOML config consumed by MCP management and Runtime Bridge.
 * An explicit CC-Switch path owns the complete config file; otherwise the
 * config remains under the resolved Codex home for native/self-hosted use.
 */
export function resolveCodexConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configuredPath = environment.COMIC_CC_SWITCH_CODEX_CONFIG_PATH?.trim();
  return configuredPath
    ? path.resolve(configuredPath)
    : path.join(resolveCodexHomeDirectory(environment, homeDirectory), 'config.toml');
}

const CLAUDE_PROJECT_DIRECTORY_MAX_LENGTH = 200;
const CLAUDE_PROJECT_DIRECTORY_OVERRIDE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CLAUDE_RESERVED_PROJECT_DIRECTORY_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Builds the Claude SDK's project directory key for a workspace path.
 *
 * The SDK resolves an existing workspace through `realpath`, normalizes macOS
 * paths to NFC, replaces every non-alphanumeric character with `-`, and adds
 * a signed 32-bit Java-style hash when the key exceeds 200 characters. When a
 * valid `CLAUDE_CODE_PROJECT_DIR_NAME` is present while Claude uses a custom
 * `CLAUDE_CONFIG_DIR`, the SDK uses that explicit key instead. This helper is
 * shared by history fallback, synchronizers, token usage, and fork validation
 * so all callers address the same native transcript directory.
 *
 * Returns `null` for malformed input or an invalid configured override rather
 * than guessing a path. The optional environment argument exists for tests and
 * callers that already captured a deployment environment snapshot.
 */
export function buildClaudeProjectDirectoryName(
  projectPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return null;
  }

  let resolvedPath: string;
  try {
    resolvedPath = path.resolve(projectPath);
  } catch {
    return null;
  }

  // This mirrors the SDK's existing-directory resolution. A missing path is
  // kept lexical because Claude itself falls back to that value before a
  // transcript directory exists.
  let canonicalPath = resolvedPath;
  try {
    canonicalPath = realpathSync(resolvedPath);
  } catch {
    // Keep the resolved lexical path.
  }
  if (process.platform === 'darwin') {
    canonicalPath = canonicalPath.normalize('NFC');
  }

  const configuredOverride = environment?.CLAUDE_CODE_PROJECT_DIR_NAME;
  const nativeConfigDirectory = typeof environment?.CLAUDE_CONFIG_DIR === 'string'
    ? environment.CLAUDE_CONFIG_DIR.trim()
    : '';
  const appConfigDirectory = typeof environment?.COMIC_CLAUDE_CONFIG_DIR === 'string'
    ? environment.COMIC_CLAUDE_CONFIG_DIR.trim()
    : '';
  const hasCustomConfigDirectory = Boolean(nativeConfigDirectory || appConfigDirectory);
  if (hasCustomConfigDirectory && configuredOverride !== undefined) {
    if (
      typeof configuredOverride !== 'string'
      || !CLAUDE_PROJECT_DIRECTORY_OVERRIDE_PATTERN.test(configuredOverride)
      || CLAUDE_RESERVED_PROJECT_DIRECTORY_NAMES.test(configuredOverride)
    ) {
      return null;
    }
    return configuredOverride;
  }

  const encoded = canonicalPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= CLAUDE_PROJECT_DIRECTORY_MAX_LENGTH) {
    return encoded;
  }

  let hash = 0;
  for (let index = 0; index < canonicalPath.length; index += 1) {
    hash = (hash << 5) - hash + canonicalPath.charCodeAt(index) | 0;
  }
  return `${encoded.slice(0, CLAUDE_PROJECT_DIRECTORY_MAX_LENGTH)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Builds the top-level Claude transcript path for one project/session pair.
 *
 * Claude stores each main conversation as `<provider-session-id>.jsonl` below
 * the SDK project key. Provider session ids are runtime-owned but still
 * treated as untrusted path input: values containing a path separator return
 * `null`, and the final candidate is constrained to the project directory.
 */
export function buildClaudeTranscriptFilePath(
  claudeConfigDirectory: string,
  projectPath: string,
  providerSessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof claudeConfigDirectory !== 'string' || !claudeConfigDirectory.trim()) {
    return null;
  }

  const transcriptFileName = `${providerSessionId}.jsonl`;
  if (path.basename(transcriptFileName) !== transcriptFileName) {
    return null;
  }

  // `claudeConfigDirectory` is the deployment-resolved equivalent of the
  // SDK's `CLAUDE_CONFIG_DIR`. CloudCLI commonly supplies it through
  // `COMIC_CLAUDE_CONFIG_DIR`, so synthesize the effective native variable
  // and never let an ambient process value replace the caller's explicit
  // config root.
  const effectiveEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    CLAUDE_CONFIG_DIR: claudeConfigDirectory,
  };
  const encodedProjectPath = buildClaudeProjectDirectoryName(
    projectPath,
    effectiveEnvironment,
  );
  if (!encodedProjectPath) {
    return null;
  }

  const projectDirectory = path.join(
    path.resolve(claudeConfigDirectory),
    'projects',
    encodedProjectPath,
  );
  const candidatePath = path.join(projectDirectory, transcriptFileName);
  const relativePath = path.relative(projectDirectory, candidatePath);

  return relativePath.startsWith('..') || path.isAbsolute(relativePath)
    ? null
    : candidatePath;
}

//----------------- PROVIDER TRANSCRIPT PATH VALIDATION ------------
/**
 * Provider transcript formats whose paths may be persisted in the sessions
 * database.  This intentionally excludes OpenCode: its history and usage are
 * stored in one SQLite database rather than a per-session JSONL file.
 */
export type JsonlTranscriptProvider = 'claude' | 'codex';

/**
 * Input to {@link validateProviderTranscriptPath}.  `rootPath` must be the
 * deployment-owned provider storage root (`<claude-config>/projects` or
 * `<codex-home>/sessions`), never a request-supplied workspace path.
 */
export type ProviderTranscriptPathValidationInput = {
  provider: JsonlTranscriptProvider;
  candidatePath: string;
  rootPath: string;
  providerSessionId: string;
  /** Codex callers can explicitly require a sub-agent or top-level rollout. */
  expectedSubagent?: boolean;
  /**
   * Optional session cwd binding. When supplied, the opening provider
   * envelope must identify this exact project/runtime path. This is required
   * for isolated sessions whose sidebar `project_path` differs from their
   * private `runtime_path`; an indexed source transcript must not be reused.
   */
  expectedProjectPath?: string | null;
  /**
   * Optional captured environment used for provider-native project-key rules.
   * Callers that coordinate with Claude's fork compatibility lock should pass
   * this snapshot so a temporary process-level config override cannot change
   * validation after an async filesystem read.
   */
  environment?: NodeJS.ProcessEnv;
};

/**
 * Input for the filesystem-only transcript preflight.
 *
 * Synchronizers discover the native session id by reading the first JSONL
 * envelope, so the id is optional here.  Callers that already have an id
 * should provide it: the preflight can then reject a wrong basename before
 * opening the file.  This helper never reads file contents.
 */
export type ProviderTranscriptPathPreflightInput = {
  provider: JsonlTranscriptProvider;
  candidatePath: string;
  rootPath: string;
  providerSessionId?: string;
};

/** Canonical path returned by the content-free transcript preflight. */
export type ProviderTranscriptPathPreflightResult = {
  canonicalPath: string;
  canonicalRoot: string;
  /** Device/inode captured before the authenticated descriptor is opened. */
  device: number;
  inode: number;
};

/**
 * A provider transcript opened after path and metadata authentication.
 *
 * Consumers that need to parse transcript bytes should keep this descriptor
 * for the whole read instead of validating a path and then opening that path
 * again. `FileHandle` ownership belongs to the caller, which must close it in
 * a `finally` block. The device/inode comparison is a last-mile replacement
 * check; Node does not expose `openat(2)`, so callers must still treat this as
 * race reduction rather than a claim of full directory-descriptor atomicity.
 */
export type AuthenticatedProviderTranscript = {
  canonicalPath: string;
  canonicalRoot: string;
  /** Device/inode identity of the descriptor-backed transcript. */
  device: number;
  inode: number;
  handle: FileHandle;
  firstRecord: unknown;
};

/** Input for the metadata-only half of provider transcript validation. */
export type ProviderTranscriptRecordValidationInput = {
  provider: JsonlTranscriptProvider;
  preflight: ProviderTranscriptPathPreflightResult;
  firstRecord: unknown;
  providerSessionId: string;
  /** Codex callers can explicitly require a sub-agent or top-level rollout. */
  expectedSubagent?: boolean;
  /** Optional project/runtime cwd binding from the owning app session. */
  expectedProjectPath?: string | null;
  /** Environment snapshot for native project-key/override validation. */
  environment?: NodeJS.ProcessEnv;
};

function isSafeProviderSessionId(value: unknown): value is string {
  // This value ultimately comes from SQLite and older API callers, so the
  // runtime check must happen before path helpers (which throw on non-strings).
  if (typeof value !== 'string') {
    return false;
  }

  return Boolean(
    value
      && value !== '.'
      && value !== '..'
      && !path.isAbsolute(value)
      // IDs are opaque provider values, not filenames. Reject both host path
      // separators and Windows drive/ADS syntax even on POSIX deployments.
      && !/[\\/:\0-\x1f\x7f]/.test(value)
      && path.basename(value) === value,
  );
}

function isCanonicalPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Checks the provider-native filename convention without opening a file.
 *
 * Claude stores top-level sessions as `<id>.jsonl`.  Codex has both the
 * legacy `<id>.jsonl` form and the current `rollout-<timestamp>-<id>.jsonl`
 * form.  The suffix check deliberately uses the complete id rather than
 * splitting on `-`, because UUID ids themselves contain hyphens.
 */
export function isExpectedProviderTranscriptFileName(
  provider: JsonlTranscriptProvider,
  candidatePath: string,
  providerSessionId: string,
): boolean {
  if (!isSafeProviderSessionId(providerSessionId)) {
    return false;
  }

  const basename = path.basename(candidatePath);
  if (provider === 'claude') {
    return basename === `${providerSessionId}.jsonl`;
  }

  return basename === `${providerSessionId}.jsonl`
    || (
      basename.startsWith('rollout-')
      && basename.endsWith(`-${providerSessionId}.jsonl`)
    );
}

/**
 * Returns whether a path has a safe provider transcript filename before the
 * native id is known.  The subsequent metadata validation still has to bind
 * the id to this basename; this only prevents an obviously unrelated leaf
 * (for example a directory named `x.jsonl`) from being opened first.
 */
function hasPotentialProviderTranscriptFileName(
  provider: JsonlTranscriptProvider,
  candidatePath: string,
): boolean {
  const basename = path.basename(candidatePath);
  const stem = basename.slice(0, -'.jsonl'.length);
  if (!stem || !isSafeProviderSessionId(stem)) {
    return false;
  }

  // A direct safe stem is the supported legacy layout for both providers;
  // current Codex rollouts are additionally covered by the `rollout-` form.
  // Keep the provider branch explicit so a future format cannot accidentally
  // bypass this preflight by changing only the shared filename helper.
  return provider === 'claude' || provider === 'codex';
}

/**
 * Rejects symlinked path components below a provider root.
 *
 * The configured root itself may be a deployment symlink (it is canonicalized
 * separately), but provider-owned project/session directories and the final
 * JSONL leaf must be ordinary filesystem entries.  Refusing parent symlinks,
 * including ones that currently resolve back inside the root, keeps the
 * synchronizer fail-closed if an operator later retargets that link.
 */
async function hasSymlinkedPathComponentBelowRoot(
  lexicalRoot: string,
  lexicalCandidate: string,
): Promise<boolean> {
  const relativeParent = path.relative(lexicalRoot, path.dirname(lexicalCandidate));
  if (
    relativeParent === '..'
    || relativeParent.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeParent)
  ) {
    return true;
  }

  if (relativeParent === '') {
    return false;
  }

  let currentPath = lexicalRoot;
  for (const segment of relativeParent.split(path.sep)) {
    if (!segment || segment === '.') {
      continue;
    }
    currentPath = path.join(currentPath, segment);
    try {
      if ((await lstat(currentPath)).isSymbolicLink()) {
        return true;
      }
    } catch {
      // The caller's realpath/stat checks will reject a missing/inaccessible
      // component.  Returning true here avoids probing the candidate file.
      return true;
    }
  }

  return false;
}

/**
 * Performs the content-free half of transcript authentication.
 *
 * This function is intentionally separate from
 * {@link validateProviderTranscriptPath}: a synchronizer must establish root
 * containment, symlink policy, regular-file type, and filename shape before
 * it reads even the first JSONL record.  It returns canonical paths so the
 * caller does not continue with a lexical database/watcher path.
 */
export async function preflightProviderTranscriptPath(
  input: ProviderTranscriptPathPreflightInput,
): Promise<ProviderTranscriptPathPreflightResult | null> {
  if (!input || (input.provider !== 'claude' && input.provider !== 'codex')) {
    return null;
  }
  if (
    typeof input.candidatePath !== 'string'
    || !input.candidatePath.trim()
    || typeof input.rootPath !== 'string'
    || !input.rootPath.trim()
    || !input.candidatePath.toLowerCase().endsWith('.jsonl')
  ) {
    return null;
  }
  if (
    input.providerSessionId !== undefined
    && !isSafeProviderSessionId(input.providerSessionId)
  ) {
    return null;
  }

  try {
    const lexicalRoot = path.resolve(input.rootPath);
    const lexicalCandidate = path.resolve(input.candidatePath);
    if (!isCanonicalPathInsideRoot(lexicalRoot, lexicalCandidate)) {
      return null;
    }

    if (
      input.providerSessionId
        ? !isExpectedProviderTranscriptFileName(
          input.provider,
          lexicalCandidate,
          input.providerSessionId,
        )
        : !hasPotentialProviderTranscriptFileName(input.provider, lexicalCandidate)
    ) {
      return null;
    }

    const canonicalRoot = path.resolve(await realpath(lexicalRoot));
    // Do this before reading the candidate.  In particular, a parent symlink
    // must not get a chance to redirect the first JSONL read outside root.
    if (await hasSymlinkedPathComponentBelowRoot(lexicalRoot, lexicalCandidate)) {
      return null;
    }

    const lexicalStat = await lstat(lexicalCandidate);
    if (lexicalStat.isSymbolicLink()) {
      return null;
    }

    const canonicalCandidate = path.resolve(await realpath(lexicalCandidate));
    if (!isCanonicalPathInsideRoot(canonicalRoot, canonicalCandidate)) {
      return null;
    }

    // Claude's top-level transcript is exactly one encoded-project directory
    // below `projects`; this also excludes subagents/tool-results before any
    // content read.  Codex's date directory depth is version-dependent and is
    // intentionally left flexible.
    if (input.provider === 'claude') {
      const relativeParts = path.relative(canonicalRoot, canonicalCandidate)
        .split(path.sep);
      if (relativeParts.length !== 2) {
        return null;
      }
    }

    const candidateStat = await stat(canonicalCandidate);
    if (!candidateStat.isFile()) {
      return null;
    }

    return {
      canonicalPath: canonicalCandidate,
      canonicalRoot,
      device: candidateStat.dev,
      inode: candidateStat.ino,
    };
  } catch {
    return null;
  }
}

/**
 * Opens a previously canonicalized regular file with a no-follow final leaf.
 *
 * The caller must have obtained `filePath` from an authenticated preflight (or
 * another equivalent boundary). The descriptor is checked with `fstat` before
 * it is returned, so a final-component replacement between validation and the
 * open is rejected. This helper is intentionally generic enough for history,
 * search, synchronizer, and token readers, while keeping all descriptor
 * lifecycle ownership explicit at the call site.
 */
export async function openProviderTranscriptReadHandle(
  filePath: string,
  expectedIdentity?: { device: number; inode: number },
): Promise<{ handle: FileHandle; device: number; inode: number } | null> {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) {
    return null;
  }

  // Silently dropping O_NOFOLLOW on a platform that does not expose it would
  // turn this helper into an ordinary path open while callers still believe
  // the final symlink was rejected. Fail closed until a platform-specific
  // descriptor primitive is added.
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    return null;
  }

  let handle: FileHandle | null = null;
  try {
    const lexicalPath = path.resolve(filePath);
    const lexicalStat = await lstat(lexicalPath);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
      return null;
    }
    const canonicalPath = path.resolve(await realpath(lexicalPath));
    // Callers pass canonical provider paths. Refusing a path whose lexical
    // spelling resolves elsewhere also protects generic readers that reuse
    // this helper without a provider preflight.
    if (canonicalPath !== lexicalPath) {
      return null;
    }
    if (
      expectedIdentity !== undefined
      && (lexicalStat.dev !== expectedIdentity.device || lexicalStat.ino !== expectedIdentity.inode)
    ) {
      return null;
    }

    handle = await open(lexicalPath, fs.constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile()
      || fileStat.dev !== lexicalStat.dev
      || fileStat.ino !== lexicalStat.ino
    ) {
      await closeProviderTranscriptReadHandle(handle);
      return null;
    }

    // A parent directory can be renamed/replaced while the open is in flight.
    // Re-resolving the lexical path and comparing the identity gives a
    // deterministic post-open check for that common replacement race. Node's
    // standard API has no openat(2), so this remains a reduction, not a full
    // directory-descriptor guarantee.
    let postOpenCanonicalPath: string;
    try {
      postOpenCanonicalPath = path.resolve(await realpath(lexicalPath));
    } catch {
      await closeProviderTranscriptReadHandle(handle);
      return null;
    }
    if (postOpenCanonicalPath !== canonicalPath) {
      await closeProviderTranscriptReadHandle(handle);
      return null;
    }

    return {
      handle,
      device: fileStat.dev,
      inode: fileStat.ino,
    };
  } catch {
    if (handle) {
      try {
        await closeProviderTranscriptReadHandle(handle);
      } catch {
        // Best-effort cleanup after a failed open/stat.
      }
    }
    return null;
  }
}

/**
 * Reads the first non-empty JSONL record from an already-open descriptor.
 *
 * The descriptor is never closed here. This lets authenticated callers use
 * the same file object for metadata and body reads without reopening a path;
 * callers own and must close it. Positional reads start at offset zero without
 * changing the descriptor's shared cursor, which lets the same handle continue
 * into a body/tail read afterward.
 */
export async function readFirstJsonlRecordFromHandle(
  handle: FileHandle,
): Promise<unknown | null> {
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(64 * 1024);
  const maxFirstRecordBytes = 8 * 1024 * 1024;
  let pending = '';
  let position = 0;
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) {
        pending += decoder.end();
        break;
      }
      position += result.bytesRead;
      pending += decoder.write(buffer.subarray(0, result.bytesRead));

      const newline = pending.indexOf('\n');
      if (newline < 0) {
        if (pending.length > maxFirstRecordBytes) {
          return null;
        }
        continue;
      }

      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          return JSON.parse(trimmed);
        } catch {
          return null;
        }
      }
    }
  } catch {
    return null;
  }

  const trimmed = pending.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Closes a descriptor that may already have been closed by a consumer-owned
 * read stream. Node and Bun differ on whether that second close resolves or
 * rejects with `EBADF`; treating the already-closed state as success keeps
 * cleanup deterministic without hiding other I/O failures.
 */
export async function closeProviderTranscriptReadHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EBADF') {
      throw error;
    }
  }
}

/**
 * Reads only the first non-empty JSONL record from a provider transcript.
 * Provider identity is established by the opening envelope; searching for a
 * later matching record would let a file for another session (or a malformed
 * file) masquerade as the requested transcript. This helper is intentionally
 * strict and is shared by transcript validators and synchronizers. Generic
 * JSONL consumers should continue using `extractFirstValidJsonlData`, whose
 * historical behavior is to scan until a matching row is found.
 */
export async function readFirstJsonlRecord(filePath: string): Promise<unknown | null> {
  const opened = await openProviderTranscriptReadHandle(filePath);
  if (!opened) {
    return null;
  }
  try {
    return await readFirstJsonlRecordFromHandle(opened.handle);
  } finally {
    await closeProviderTranscriptReadHandle(opened.handle);
  }
}

/**
 * Authenticates and opens one provider transcript for descriptor-backed reads.
 *
 * Path containment, symlink policy, filename shape, and provider metadata are
 * all checked before the handle is returned. The caller owns the returned
 * descriptor and must close it. `validateProviderTranscriptPath` remains as a
 * compatibility wrapper for callers that only need a canonical path.
 */
export async function openValidatedProviderTranscript(
  input: ProviderTranscriptPathValidationInput,
): Promise<AuthenticatedProviderTranscript | null> {
  if (!input || !isSafeProviderSessionId(input.providerSessionId)) {
    return null;
  }

  const preflight = await preflightProviderTranscriptPath({
    provider: input.provider,
    candidatePath: input.candidatePath,
    rootPath: input.rootPath,
    providerSessionId: input.providerSessionId,
  });
  if (!preflight) {
    return null;
  }

  const opened = await openProviderTranscriptReadHandle(preflight.canonicalPath, {
    device: preflight.device,
    inode: preflight.inode,
  });
  if (!opened) {
    return null;
  }

  const firstRecord = await readFirstJsonlRecordFromHandle(opened.handle);
  if (!validateProviderTranscriptRecord({
    provider: input.provider,
    preflight,
    firstRecord,
    providerSessionId: input.providerSessionId,
    expectedSubagent: input.expectedSubagent,
    expectedProjectPath: input.expectedProjectPath,
    environment: input.environment,
  })) {
    await closeProviderTranscriptReadHandle(opened.handle);
    return null;
  }

  return {
    canonicalPath: preflight.canonicalPath,
    canonicalRoot: preflight.canonicalRoot,
    device: opened.device,
    inode: opened.inode,
    handle: opened.handle,
    firstRecord,
  };
}

/**
 * Authenticates the already-read opening envelope against a successful path
 * preflight without touching the filesystem again.
 *
 * Synchronizers do not know a provider session id until they inspect the
 * opening record. Keeping this second half separate lets them bind the native
 * id, filename, Claude cwd directory, and Codex thread kind to the canonical
 * preflight result. It also avoids feeding a canonical candidate back through
 * a lexical symlink root, which would incorrectly reject valid deployments.
 */
export function validateProviderTranscriptRecord(
  input: ProviderTranscriptRecordValidationInput,
): boolean {
  if (
    !input
    || (input.provider !== 'claude' && input.provider !== 'codex')
    || !isSafeProviderSessionId(input.providerSessionId)
    || !input.preflight
    || typeof input.preflight.canonicalPath !== 'string'
    || typeof input.preflight.canonicalRoot !== 'string'
    || !path.isAbsolute(input.preflight.canonicalPath)
    || !path.isAbsolute(input.preflight.canonicalRoot)
  ) {
    return false;
  }

  const canonicalPath = path.resolve(input.preflight.canonicalPath);
  const canonicalRoot = path.resolve(input.preflight.canonicalRoot);
  if (
    !isCanonicalPathInsideRoot(canonicalRoot, canonicalPath)
    || !isExpectedProviderTranscriptFileName(
      input.provider,
      canonicalPath,
      input.providerSessionId,
    )
  ) {
    return false;
  }

  const record = input.firstRecord
    && typeof input.firstRecord === 'object'
    && !Array.isArray(input.firstRecord)
    ? input.firstRecord as Record<string, unknown>
    : null;
  if (input.provider === 'claude') {
    if (
      !record
      || record.sessionId !== input.providerSessionId
      || typeof record.cwd !== 'string'
      || !record.cwd.trim()
    ) {
      return false;
    }

    const relativeParts = path.relative(canonicalRoot, canonicalPath).split(path.sep);
    if (relativeParts.length !== 2) {
      return false;
    }

    // `project_path` is the stable sidebar owner, while an isolated session
    // runs from `runtime_path`. Bind the authenticated opening cwd to the
    // caller's effective path before any consumer reads the transcript. This
    // prevents a stale source-checkout index from being accepted merely
    // because its provider id and Claude project key are otherwise valid.
    if (input.expectedProjectPath !== undefined && input.expectedProjectPath !== null) {
      const expectedProjectPath = typeof input.expectedProjectPath === 'string'
        ? input.expectedProjectPath.trim()
        : '';
      if (
        !expectedProjectPath
        || normalizeProjectPath(record.cwd) !== normalizeProjectPath(expectedProjectPath)
      ) {
        return false;
      }
    }

    // Bind cwd using the same native project-key rules as the path builder.
    // The canonical projects root determines the active config location; only
    // Claude's explicit project-key override is inherited from the process.
    const effectiveEnvironment: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: path.dirname(canonicalRoot),
    };
    const environment = input.environment ?? process.env;
    if (Object.prototype.hasOwnProperty.call(environment, 'CLAUDE_CODE_PROJECT_DIR_NAME')) {
      effectiveEnvironment.CLAUDE_CODE_PROJECT_DIR_NAME =
        environment.CLAUDE_CODE_PROJECT_DIR_NAME;
    }
    const expectedProjectDirectory = buildClaudeProjectDirectoryName(
      record.cwd,
      effectiveEnvironment,
    );
    return Boolean(
      expectedProjectDirectory
      && relativeParts[0] === expectedProjectDirectory,
    );
  }

  if (record?.type !== 'session_meta') {
    return false;
  }
  const payload = record.payload
    && typeof record.payload === 'object'
    && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : null;
  if (payload?.id !== input.providerSessionId) {
    return false;
  }

  if (input.expectedProjectPath !== undefined && input.expectedProjectPath !== null) {
    const expectedProjectPath = typeof input.expectedProjectPath === 'string'
      ? input.expectedProjectPath.trim()
      : '';
    const transcriptProjectPath = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
    if (
      !expectedProjectPath
      || !transcriptProjectPath
      || normalizeProjectPath(transcriptProjectPath) !== normalizeProjectPath(expectedProjectPath)
    ) {
      return false;
    }
  }

  const isSubagent = payload.thread_source === 'subagent'
    || (
      typeof payload.source === 'object'
      && payload.source !== null
      && !Array.isArray(payload.source)
      && 'subagent' in payload.source
    );
  return isSubagent === (input.expectedSubagent ?? false);
}

/**
 * Resolves and authenticates one persisted provider JSONL path.
 *
 * Database paths are treated as untrusted indexes: the final component must
 * not be a symlink, the real path must remain below the deployment-owned
 * root, the target must be a regular file, and its provider-native metadata
 * must identify the requested session.  Returning the real path lets callers
 * use one canonical value for subsequent reads and cache keys.  Any missing,
 * malformed, mismatched, or inaccessible artifact returns `null` so callers
 * can fail closed without exposing filesystem details.
 */
export async function validateProviderTranscriptPath(
  input: ProviderTranscriptPathValidationInput,
): Promise<string | null> {
  const authenticated = await openValidatedProviderTranscript(input);
  if (!authenticated) {
    return null;
  }
  await authenticated.handle.close();
  return authenticated.canonicalPath;
}

// ---------------------------
//----------------- IDENTITY VALIDATION UTILITIES ------------
/**
 * Validates the practical mailbox shape accepted for per-user Git identity.
 * User settings and execution attribution share this check so an address that
 * can be saved is also safe to inject into Git author/committer variables.
 */
export function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Filters an execution environment before it is handed to a product/QA
 * read-only provider child. Only non-secret attribution metadata is retained;
 * one-time commit receipt credentials, Git identity/configuration, hook paths,
 * and unknown future fields are omitted so a read-only model cannot use or
 * disclose the commit path. Developer executions must not call this helper.
 */
export function filterExecutionEnvironmentForReadOnly(
  environment: unknown,
): Record<string, string> {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    return {};
  }

  const allowedKeys = [
    'CLOUDCLI_ACTOR_ID',
    'CLOUDCLI_EXECUTION_RUN_ID',
    'CLOUDCLI_PROVIDER',
    'CLOUDCLI_GIT_IDENTITY_READY',
    'CLOUDCLI_GIT_IDENTITY_SHARED',
    'CLOUDCLI_IDENTITY_STATUS',
    'CLOUDCLI_SESSION_ID',
    'CLOUDCLI_PERSON_ID',
    'CLOUDCLI_HUMAN_ACTOR_REQUIRED',
  ] as const;
  const source = environment as Record<string, unknown>;
  const filtered: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = source[key];
    if (typeof value === 'string') {
      filtered[key] = value;
    }
  }
  return filtered;
}

const READ_ONLY_PROVIDER_BLOCKED_CREDENTIAL_KEYS = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'CLOUDCLI_GITHUB_TOKEN',
  'CLOUDCLI_GITLAB_TOKEN',
  'SSH_AUTH_SOCK',
]);

/**
 * Environment variables which can make a child process load or execute
 * operator-controlled code before the provider runtime has a chance to apply
 * its own policy.  This is intentionally kept separate from the credential
 * list below: model API keys are required by a provider, while startup hooks,
 * dynamic loader settings, and interpreter import paths are never required by
 * a product/QA read-only turn.  Names are compared case-insensitively because
 * Windows environment blocks are case-insensitive.
 */
const READ_ONLY_PROVIDER_BLOCKED_STARTUP_KEYS = new Set([
  'BASH_ENV',
  'BASHOPTS',
  'SHELLOPTS',
  'SHELL',
  'BASH',
  'ZSH',
  'FISH',
  'KSH',
  'ENV',
  'KSH_ENV',
  'SHINIT',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'PS4',
  'BASH_XTRACEFD',
  'CDPATH',
  'FPATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_V8_COVERAGE',
  'V8_COVERAGE',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'PYTHONWARNINGS',
  'PYTHONBREAKPOINT',
  'PYTHONDEBUG',
  'PYTHONFAULTHANDLER',
  'RUBYOPT',
  'RUBYLIB',
  'RUBY_DEBUG',
  'PERL5OPT',
  'PERL5LIB',
  'PERL_MB_OPT',
  'PERL_UNICODE',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'BUN_OPTIONS',
  'BUN_DEBUG',
  'DENO_DIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  // A pager/editor value can be interpreted as a command by Git or a native
  // CLI even when the provider itself has no shell tool enabled.
  'EDITOR',
  'VISUAL',
  'PAGER',
  'MANPAGER',
  'LESSOPEN',
  'LESSCLOSE',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  // Proxy variables may contain inline user/password credentials and can
  // redirect the model/API traffic to an operator-controlled endpoint. A
  // readonly child gets its network policy from the deployment/container;
  // never inherit ambient proxy routing from a developer shell.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  // Toolchain wrappers and debugger hooks are executable indirection points.
  'RUSTC_WRAPPER',
  'RUSTC_WORKSPACE_WRAPPER',
  'CC',
  'CXX',
  'AR',
  'AS',
  'MAKEFLAGS',
  'OPENSSL_CONF',
  'SSLKEYLOGFILE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GLIBC_TUNABLES',
  'GCONV_PATH',
  'LOCPATH',
  'QT_PLUGIN_PATH',
  'GTK_PATH',
  'GDK_PIXBUF_MODULE_FILE',
  'GSETTINGS_SCHEMA_DIR',
  'GST_PLUGIN_PATH',
  'MALLOC_CONF',
  'MALLOC_TRACE',
  'GODEBUG',
  'GOTRACEBACK',
  'RUST_LOG',
  'RUST_BACKTRACE',
  'RUST_LIB_BACKTRACE',
  'RUSTC_BOOTSTRAP',
  'COMSPEC',
  'PATHEXT',
  'DEBUG',
]);

const READ_ONLY_PROVIDER_BLOCKED_STARTUP_PREFIXES = [
  // No SSH configuration or agent forwarding is needed to inspect a source
  // checkout, and SSH_* values can redirect Git/other subprocesses to a
  // developer-controlled command or socket.
  'SSH_',
  // Dynamic loader and package-manager configuration can redirect an
  // otherwise harmless executable to a developer-controlled library/config.
  'LD_',
  'DYLD_',
  'NPM_CONFIG_',
  'BASH_FUNC_',
  'CARGO_BUILD_RUSTC_',
  'NIX_',
  'DEBUG_',
] as const;

/**
 * Provider runtime control variables are not credentials.  They are consumed
 * by the native Codex/Claude binaries before (or alongside) the SDK options
 * we pass below, so forwarding one from the host environment can reopen an
 * execution channel even when the structured sandbox/config is read-only.
 *
 * Keep this list deliberately fail-closed for provider-owned namespaces.  A
 * model credential may still be forwarded through the explicit credential
 * allow-list, but an environment variable that selects a socket, proxy,
 * plugin, agent, MCP server, alternate endpoint, or config root is never a
 * model credential and must not survive the boundary.
 */
const READ_ONLY_PROVIDER_BLOCKED_RUNTIME_KEYS = new Set([
  // Codex control/auth routing values. CODEX_API_KEY is intentionally *not*
  // here: it is part of READ_ONLY_PROVIDER_DEFAULT_CREDENTIAL_KEYS below.
  'CODEX_ACCESS_TOKEN',
  'CODEX_AUTH',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_CA_CERTIFICATE',
  'CODEX_CONNECTORS_TOKEN',
  'CODEX_EXEC_SERVER_URL',
  'CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE',
  'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_NETWORK_PROXY_ACTIVE',
  'CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE',
  'CODEX_NETWORK_PROXY_BROKERED_CREDENTIALS',
  'CODEX_NETWORK_PROXY_ATTRIBUTION',
  'CODEX_NETWORK_ALLOW_LOCAL_BINDING',
  'CODEX_OSS_PORT',
  'CODEX_OSS_BASE_URL',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_PROXY_GIT_SSH_COMMAND',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_SNAPSHOT_OVERRIDE',
  'CODEX_SQLITE_HOME',
  'CODEX_STARTING_DIFF',
  'CODEX_THREAD_ID',
  'CODEX_TUI_RECORD_SESSION',
  'CODEX_TUI_SESSION_LOG_PATH',
  'CODEX_URL',
  // Claude feature/auth switches. Only the small, explicit model endpoint and
  // model-name allowlist below is retained from the ANTHROPIC_* namespace;
  // provider-specific sockets, cloud credential selectors, identity tokens,
  // custom headers, and logging controls must not cross the boundary.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // An ambient OpenAI endpoint must not override the sanitized Codex config.
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
]);

const READ_ONLY_PROVIDER_BLOCKED_RUNTIME_PREFIXES = [
  // Future Codex controls in these namespaces should fail closed until they
  // are explicitly reviewed. CODEX_API_KEY is exempted by the predicate.
  'CODEX_EXEC_SERVER_',
  'CODEX_NETWORK_',
  'CODEX_PROXY_',
  'CODEX_SNAPSHOT_',
  'CODEX_PLUGIN_',
  'CODEX_TUI_',
  'CODEX_ROLLOUT_',
  'CODEX_SHELL_',
  'CODEX_AGENT_',
  // Claude Code's feature flags include hooks, shell, plugin, skill, and
  // remote-control toggles. The provider adapter supplies its one safe
  // timeout variable separately.
  'CLAUDE_CODE_',
  // These can redirect identity/federation or export prompt telemetry.
  'OPENAI_FEDERATION_',
  'OPENAI_IDENTITY_',
  'OTEL_',
  'MCP_',
  // These are CloudCLI/bridge configuration knobs, not provider credentials.
  // They are consumed by the parent service and must not be inherited by a
  // read-only child that could launch another helper process.
  'CLOUDCLI_',
  'COMIC_',
] as const;

const READ_ONLY_PROVIDER_ALLOWED_RUNTIME_KEYS = new Set([
  // The runtime sets this bounded wait ceiling itself. Keeping it avoids a
  // needless loss of background-turn cleanup while still rejecting all other
  // CLAUDE_CODE_* feature switches.
  'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
]);

/**
 * Claude's model endpoint and API credentials are the only useful values from
 * its otherwise broad ANTHROPIC_* environment namespace.  In particular,
 * `ANTHROPIC_UNIX_SOCKET`, cloud-provider selectors, identity/webhook tokens,
 * and custom headers can redirect transport or expose another credential
 * source, so they stay denied by `isBlockedProviderRuntimeControl` below.
 */
const READ_ONLY_PROVIDER_ALLOWED_ANTHROPIC_RUNTIME_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]);

const READ_ONLY_PROVIDER_SAFE_TIMEOUT_PATTERN = /^(?:[1-9][0-9]{0,8})$/;

function isSafeReadOnlyProviderEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      // Endpoint credentials/query fragments would be visible in child
      // arguments or logs and are not needed for model routing.
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function isBlockedProviderRuntimeControl(
  upperKey: string,
  value: string,
): boolean {
  if (READ_ONLY_PROVIDER_ALLOWED_RUNTIME_KEYS.has(upperKey)) {
    // The only explicitly allowed feature variable is a bounded numeric
    // timeout generated by this server.  Reject a host-provided value that
    // could disable the ceiling (zero/negative/very large) or inject syntax.
    return !READ_ONLY_PROVIDER_SAFE_TIMEOUT_PATTERN.test(value)
      || Number(value) > 30 * 60 * 1000;
  }

  if (upperKey.startsWith('ANTHROPIC_')) {
    if (!READ_ONLY_PROVIDER_ALLOWED_ANTHROPIC_RUNTIME_KEYS.has(upperKey)) {
      return true;
    }
    if (upperKey === 'ANTHROPIC_BASE_URL') {
      return !isSafeReadOnlyProviderEndpoint(value);
    }
    return false;
  }

  if (READ_ONLY_PROVIDER_BLOCKED_RUNTIME_KEYS.has(upperKey)) {
    return true;
  }

  return READ_ONLY_PROVIDER_BLOCKED_RUNTIME_PREFIXES.some(
    (prefix) => upperKey.startsWith(prefix),
  );
}

/**
 * Home/configuration paths which would let a provider discover a developer's
 * credentials, hooks, plugins, or MCP catalog.  A read-only child may use an
 * explicitly provisioned isolated home, but it must never inherit the
 * operator's ambient path by accident.
 */
const READ_ONLY_PROVIDER_BLOCKED_PATH_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'COMIC_CODEX_HOME',
  'COMIC_CLAUDE_CONFIG_DIR',
  'COMIC_CC_SWITCH_CODEX_CONFIG_PATH',
  'COMIC_CLAUDE_MCP_CONFIG_PATH',
  'COMIC_DATAVERSE_TOKEN_HELPER',
  'COMIC_DATAVERSE_TOKEN_HELPER_HOME',
  'COMIC_DATAVERSE_TOKEN_HELPER_CODEX_HOME',
  'CLOUDCLI_DATAVERSE_TOKEN_HELPER',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_PREFIX',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOMODCACHE',
  'PIP_CONFIG_FILE',
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // A native provider may use this to locate a replacement executable. The
  // readonly adapters must not inherit an operator/bridge supplied override;
  // the executable is selected by the server composition root instead.
  'CLAUDE_CLI_PATH',
]);

/**
 * Standard model credentials which may be forwarded when a provider caller
 * does not have a custom credential name.  Custom CC-Switch provider keys must
 * be supplied through `allowedCredentialKeys` by the provider adapter; this
 * prevents an arbitrary `*_API_KEY` left in the service account environment
 * from becoming visible to a read-only model.
 */
const READ_ONLY_PROVIDER_DEFAULT_CREDENTIAL_KEYS = new Set([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENCODE_API_KEY',
  'CURSOR_API_KEY',
]);

/** Names that are always denied even when a caller accidentally lists them. */
const READ_ONLY_PROVIDER_ALWAYS_BLOCKED_CREDENTIAL_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);

const READ_ONLY_PROVIDER_BLOCKED_CREDENTIAL_PREFIXES = [
  // These ecosystems may load a credential or signing identity implicitly
  // from the ambient environment.  A trusted model provider can opt in to a
  // non-standard *model* credential through `allowedCredentialKeys`; the
  // exact high-risk keys above remain denied regardless.
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'GCLOUD_',
  'GCP_',
  'DOCKER_',
  'KUBE_',
  'KUBERNETES_',
  'VAULT_',
  'TF_VAR_',
] as const;

// Match both conventional names (`*_API_KEY`, `*_TOKEN`) and providers that
// use a shorter `*_KEY` spelling.  The latter is easy to miss in a denylist
// and would otherwise leak an ambient credential unless the trusted adapter
// explicitly allowlists it.  A suffix boundary avoids treating unrelated
// names such as `KEYBOARD_LAYOUT` as credentials.
const READ_ONLY_PROVIDER_CREDENTIAL_NAME_PATTERN = /(?:API[_-]?KEY|(?:^|_)KEY$|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH(?:ORIZATION)?|COOKIE|BEARER|JWT|OAUTH)/i;

/** Deployment-owned path overrides used to give read-only providers an
 * isolated, writable transcript/config root without exposing the host home.
 * These values are intentionally not accepted from request payloads. */
const READ_ONLY_PROVIDER_ISOLATED_PATH_KEYS = [
  'CLOUDCLI_READONLY_HOME',
  'CLOUDCLI_READONLY_CODEX_HOME',
  'CLOUDCLI_READONLY_CLAUDE_CONFIG_DIR',
] as const;

/**
 * A child process still needs a PATH for the SDK launcher on Unix and for
 * command lookup on Windows.  In a managed readonly turn, forwarding the
 * complete parent PATH is unsafe: a bridge/config layer can put `.` or a
 * user-writable directory before the pinned provider binary.  The service
 * may provide an explicit, deployment-owned path through
 * `CLOUDCLI_READONLY_PATH`; otherwise use only the platform's conventional
 * system binary directories.  This is intentionally a conservative fallback
 * rather than an attempt to discover binaries from the caller's workspace.
 */
const READ_ONLY_PROVIDER_DEFAULT_PATH = process.platform === 'win32'
  ? 'C:\\Windows\\System32;C:\\Windows'
  : process.platform === 'darwin'
    ? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin'
    : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function normalizeReadOnlyProviderPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\u0000\r\n]/.test(value)) {
    return undefined;
  }

  const delimiter = process.platform === 'win32' ? ';' : ':';
  const pathApi = process.platform === 'win32' ? path.win32 : path.posix;
  const entries = value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    // Apply only the host platform's path grammar.  Accepting a Windows
    // drive path on Unix (or a POSIX path on Windows) would silently produce
    // a non-existent PATH entry and makes it harder to audit the deployment
    // boundary.
    .filter((entry) => pathApi.isAbsolute(entry))
    .filter((entry) => pathApi.parse(entry).root !== entry)
    // `path.normalize` would collapse dot segments. Reject them before
    // normalization so an operator typo cannot smuggle a directory outside
    // the deployment-owned binary roots.
    .filter((entry) => !entry.split(/[\\/]+/).some((segment) => (
      segment === '.' || segment === '..'
    )));

  const uniqueEntries = [...new Set(entries)];
  return uniqueEntries.length > 0 ? uniqueEntries.join(delimiter) : undefined;
}

/** Options controlled by the server-side provider adapter, never by a Web
 * request.  The allowlist is needed for CC-Switch custom model providers. */
export type ReadOnlyProviderEnvironmentOptions = {
  allowedCredentialKeys?: readonly string[];
  /**
   * Refuse to construct a provider child environment unless the deployment
   * supplies an absolute, dedicated state root.  Native provider binaries can
   * recover the operating-system account home even when HOME is omitted, so
   * simply deleting an inherited HOME value is not enough for a shared
   * product/QA service.  Runtime adapters enable this flag; standalone filter
   * callers keep the historical best-effort behavior for compatibility.
   */
  requireIsolatedHome?: boolean;
};

function readAbsoluteProviderPath(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  // Do not turn a relative value into a path under the provider cwd.  Use the
  // host platform's path rules here: accepting a Windows-looking path on Unix
  // (or vice versa) would make `path.join` reinterpret it as a relative path.
  const pathApi = process.platform === 'win32' ? path.win32 : path.posix;
  if (!normalized || /[\u0000\r\n]/.test(normalized) || !pathApi.isAbsolute(normalized)) {
    return null;
  }

  // A dedicated provider home must be a real child directory, never a
  // filesystem root. Reject dot segments before normalization so an operator
  // typo such as `/srv/cloudcli/../Users/macos` cannot silently escape the
  // intended state root.
  const segments = normalized.split(/[\\/]+/);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  const canonical = pathApi.normalize(normalized);
  return pathApi.parse(canonical).root === canonical ? null : canonical;
}

/**
 * Removes Git and commit-receipt credentials from a complete provider child
 * environment while preserving model-provider credentials and ordinary
 * process settings. Provider/app control namespaces are filtered as well:
 * native Codex/Claude binaries can consult those variables before SDK options,
 * so forwarding them would undermine the structured read-only sandbox. This
 * is a second, defense-in-depth filter for runtimes: callers should first pass
 * only their execution attribution map through `filterExecutionEnvironmentForReadOnly`,
 * then apply this function after all bridge and host environment layers have
 * been merged.
 */
export function filterProviderEnvironmentForReadOnly(
  environment: unknown,
  options: ReadOnlyProviderEnvironmentOptions = {},
): Record<string, string> {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    return {};
  }

  const source = environment as Record<string, unknown>;
  const filtered: Record<string, string> = {};
  const isolatedHome = readAbsoluteProviderPath(source, 'CLOUDCLI_READONLY_HOME');
  const isolatedCodexHome = readAbsoluteProviderPath(source, 'CLOUDCLI_READONLY_CODEX_HOME')
    ?? (isolatedHome ? path.join(isolatedHome, '.codex') : null);
  const isolatedClaudeConfig = readAbsoluteProviderPath(
    source,
    'CLOUDCLI_READONLY_CLAUDE_CONFIG_DIR',
  ) ?? (isolatedHome ? path.join(isolatedHome, '.claude') : null);
  if (options.requireIsolatedHome && !isolatedHome) {
    throw new AppError(
      'Read-only provider runtime requires an absolute CLOUDCLI_READONLY_HOME.',
      {
        code: 'READ_ONLY_PROVIDER_HOME_REQUIRED',
        statusCode: 503,
        details: { variable: 'CLOUDCLI_READONLY_HOME' },
      },
    );
  }
  const allowedCredentialKeys = new Set([
    ...READ_ONLY_PROVIDER_DEFAULT_CREDENTIAL_KEYS,
    ...(options.allowedCredentialKeys ?? []).filter((key): key is string => typeof key === 'string'),
  ].map((key) => key.toUpperCase()));
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') {
      continue;
    }

    const upperKey = key.toUpperCase();
    const isGitConfiguration = upperKey.startsWith('GIT_');
    const isCommitReceipt = upperKey === 'CLOUDCLI_COMMIT_RECEIPT_URL'
      || upperKey === 'CLOUDCLI_COMMIT_RECEIPT_TOKEN';
    const isGitCredential = READ_ONLY_PROVIDER_BLOCKED_CREDENTIAL_KEYS.has(upperKey);
    const isAlwaysBlockedCredential = READ_ONLY_PROVIDER_ALWAYS_BLOCKED_CREDENTIAL_KEYS.has(upperKey);
    const isBlockedCredentialPrefix = READ_ONLY_PROVIDER_BLOCKED_CREDENTIAL_PREFIXES.some(
      (prefix) => upperKey.startsWith(prefix),
    ) && !allowedCredentialKeys.has(upperKey);
    const isUnlistedCredential = READ_ONLY_PROVIDER_CREDENTIAL_NAME_PATTERN.test(upperKey)
      && !allowedCredentialKeys.has(upperKey);
    const isMcpCredential = upperKey.startsWith('CLOUDCLI_MCP_')
      || upperKey === 'TE_MCP_TOKEN'
      || upperKey === 'TE_MCP_TOKEN_FILE'
      || upperKey.startsWith('CLOUDCLI_THINKINGDATA_MCP_');
    const isStartupInjection = READ_ONLY_PROVIDER_BLOCKED_STARTUP_KEYS.has(upperKey)
      || READ_ONLY_PROVIDER_BLOCKED_STARTUP_PREFIXES.some((prefix) => upperKey.startsWith(prefix));
    const isPathConfiguration = READ_ONLY_PROVIDER_BLOCKED_PATH_KEYS.has(upperKey)
      || READ_ONLY_PROVIDER_ISOLATED_PATH_KEYS.includes(
        upperKey as (typeof READ_ONLY_PROVIDER_ISOLATED_PATH_KEYS)[number],
      )
      // Preserve legacy standalone filtering behavior for callers that do not
      // opt into the managed runtime contract. Provider adapters always set
      // `requireIsolatedHome`, so their child never receives an ambient PATH.
      || (options.requireIsolatedHome && upperKey === 'PATH');
    const isProviderRuntimeControl = isBlockedProviderRuntimeControl(upperKey, value);
    // Environment names are normally supplied by the OS, but bridge/config
    // layers are application data.  Do not let a specially named property
    // mutate the output object's prototype while this filter is applied.
    const isPrototypeKey = upperKey === '__PROTO__'
      || upperKey === 'CONSTRUCTOR'
      || upperKey === 'PROTOTYPE';
    if (
      isGitConfiguration
      || isCommitReceipt
      || isGitCredential
      || isAlwaysBlockedCredential
      || isBlockedCredentialPrefix
      || isUnlistedCredential
      || isMcpCredential
      || isStartupInjection
      || isPathConfiguration
      || isProviderRuntimeControl
      || isPrototypeKey
    ) {
      continue;
    }
    filtered[key] = value;
  }

  // If the deployment explicitly provisions an isolated state root, map it to
  // the native variables the provider SDKs understand.  Without this opt-in
  // no HOME/config path is emitted at all; the OS-level service account or
  // container boundary remains the final fallback and must still be isolated.
  if (isolatedHome) {
    filtered.HOME = isolatedHome;
    // USERPROFILE is needed by native Windows provider binaries; it points to
    // the same deployment-owned root and never to an operator's profile.
    filtered.USERPROFILE = isolatedHome;
  }
  if (isolatedCodexHome) {
    filtered.CODEX_HOME = isolatedCodexHome;
  }
  if (isolatedClaudeConfig) {
    filtered.CLAUDE_CONFIG_DIR = isolatedClaudeConfig;
  }
  if (isolatedHome) {
    // Keep provider temporary files inside the deployment-owned state root as
    // well. This avoids inheriting a shared/operator `/tmp` when a native CLI
    // materializes prompts, images, or transport sockets before startup.
    const isolatedTmp = path.join(isolatedHome, 'tmp');
    filtered.TMPDIR = isolatedTmp;
    filtered.TMP = isolatedTmp;
    filtered.TEMP = isolatedTmp;
  }

  if (options.requireIsolatedHome) {
    // `CLOUDCLI_READONLY_PATH` is deployment-owned startup configuration and
    // is read before the generic CLOUDCLI_* block above. Never accept PATH
    // from a bridge/runtime payload; if no explicit path is configured, use
    // only the conservative system fallback declared above.
    const explicitPath = normalizeReadOnlyProviderPath(
      source.CLOUDCLI_READONLY_PATH,
    );
    filtered.PATH = explicitPath ?? READ_ONLY_PROVIDER_DEFAULT_PATH;
  }
  return filtered;
}

/**
 * Resolves the authenticated user id attached during a websocket upgrade.
 * Chat and Shell gateways share this boundary so identity attribution never
 * falls back to a browser-supplied message field.
 */
export function readAuthenticatedWebSocketUserId(
  request: AuthenticatedWebSocketRequest | undefined,
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }
  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }
  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }
  return null;
}

/**
 * Resolves and validates the authenticated user id attached by HTTP auth
 * middleware. Collaboration and Git routes use this instead of accepting an
 * actor id in request bodies.
 */
export function readAuthenticatedHttpUserId(request: Request): number {
  const authenticatedRequest = request as Request & {
    user?: { id?: string | number; userId?: string | number };
  };
  const rawUserId = authenticatedRequest.user?.id ?? authenticatedRequest.user?.userId;
  const userId = typeof rawUserId === 'number' ? rawUserId : Number(rawUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Authenticated user is required.', {
      code: 'AUTHENTICATION_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

// ---------------------------
//----------------- NORMALIZED MESSAGE HELPER INPUT TYPES ------------
/**
 * Input payload accepted by `createNormalizedMessage`.
 *
 * Callers provide provider-specific fields plus the required `kind/provider`
 * pair; this helper fills missing envelope fields (`id`, `sessionId`,
 * `timestamp`) in a consistent way.
 */
type NormalizedMessageInput =
  {
    kind: NormalizedMessage['kind'];
    provider: NormalizedMessage['provider'];
    id?: string | null;
    sessionId?: string | null;
    timestamp?: string | null;
  } & Record<string, unknown>;

// ---------------------------
//----------------- HTTP HANDLER UTILITIES ------------
/**
 * Wraps arbitrary data in the standard API success envelope.
 *
 * Use this helper in route handlers to keep successful JSON responses consistent
 * across endpoints.
 */
export function createApiSuccessResponse<TData>(
  data: TData,
): ApiSuccessShape<TData> {
  return {
    success: true,
    data,
  };
}

/**
 * Converts an async Express handler into a standard `RequestHandler` and routes
 * rejected promises to Express error middleware.
 *
 * Use this to avoid repeating `try/catch(next)` in every async route.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ---------------------------
//----------------- SHARED ERROR UTILITIES ------------
/**
 * Shared application error with HTTP status and machine-readable code metadata.
 *
 * Throw this from service/route layers when the caller should receive a
 * controlled error response rather than a generic 500.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
  }
}

// ---------------------------
//----------------- WORKSPACE PATH VALIDATION UTILITIES ------------
/**
 * Root directory that all workspace/project paths must stay under.
 *
 * This is resolved from `WORKSPACES_ROOT` when configured; otherwise it falls
 * back to the current user's home directory.
 */
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();

/**
 * System-critical paths that must never be used as workspace roots.
 *
 * The validation helper blocks these values directly and also blocks paths
 * nested under them (with explicit allow-list exceptions where necessary).
 */
export const FORBIDDEN_WORKSPACE_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin',
];

function stripWindowsLongPathPrefix(inputPath: string): string {
  if (inputPath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${inputPath.slice('\\\\?\\UNC\\'.length)}`;
  }

  if (inputPath.startsWith('\\\\?\\')) {
    return inputPath.slice('\\\\?\\'.length);
  }

  return inputPath;
}

function shouldUseWindowsPathNormalization(inputPath: string): boolean {
  if (process.platform === 'win32') {
    return true;
  }

  return inputPath.startsWith('\\\\') || /^[a-zA-Z]:([\\/]|$)/.test(inputPath);
}

/**
 * Canonicalizes project/workspace paths for stable DB keys and comparisons.
 *
 * Normalization rules:
 * - trim whitespace
 * - strip Windows long-path prefixes (`\\?\` and `\\?\UNC\`)
 * - normalize path separators and dot segments
 * - trim trailing separators except for filesystem roots
 */
export function normalizeProjectPath(inputPath: string): string {
  if (typeof inputPath !== 'string') {
    return '';
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }

  const withoutLongPrefix = stripWindowsLongPathPrefix(trimmed);
  const useWindowsPathRules = shouldUseWindowsPathNormalization(withoutLongPrefix);
  const normalized = useWindowsPathRules
    ? path.win32.normalize(withoutLongPrefix)
    : path.posix.normalize(withoutLongPrefix);

  if (!normalized) {
    return '';
  }

  const parser = useWindowsPathRules ? path.win32 : path.posix;
  const root = parser.parse(normalized).root;
  if (normalized === root) {
    return normalized;
  }

  return normalized.replace(/[\\/]+$/, '');
}

/**
 * Validates that a user-supplied workspace path is safe to use.
 *
 * Call this before any filesystem mutation that creates or registers projects.
 * The function resolves symlinks, enforces `WORKSPACES_ROOT` containment, and
 * blocks known system directories.
 */
export async function validateWorkspacePath(requestedPath: string): Promise<WorkspacePathValidationResult> {
  try {
    const normalizedRequestedPath = normalizeProjectPath(requestedPath);
    if (!normalizedRequestedPath) {
      return {
        valid: false,
        error: 'Workspace path is required',
      };
    }

    const absolutePath = path.resolve(normalizedRequestedPath);
    const normalizedPath = normalizeProjectPath(absolutePath);

    if (FORBIDDEN_WORKSPACE_PATHS.includes(normalizedPath) || normalizedPath === '/') {
      return {
        valid: false,
        error: 'Cannot use system-critical directories as workspace locations',
      };
    }

    for (const forbiddenPath of FORBIDDEN_WORKSPACE_PATHS) {
      const normalizedForbiddenPath = normalizeProjectPath(forbiddenPath);
      if (
        normalizedPath === normalizedForbiddenPath
        || normalizedPath.startsWith(`${normalizedForbiddenPath}${path.sep}`)
      ) {
        // Allow specific user-writable folders under /var.
        if (
          normalizedForbiddenPath === '/var'
          && (normalizedPath.startsWith('/var/tmp') || normalizedPath.startsWith('/var/folders'))
        ) {
          continue;
        }

        return {
          valid: false,
          error: `Cannot create workspace in system directory: ${forbiddenPath}`,
        };
      }
    }

    let resolvedPath = normalizeProjectPath(absolutePath);
    try {
      await access(absolutePath);
      resolvedPath = normalizeProjectPath(await realpath(absolutePath));
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }

      const parentPath = path.dirname(absolutePath);
      try {
        const parentRealPath = await realpath(parentPath);
        resolvedPath = normalizeProjectPath(path.join(parentRealPath, path.basename(absolutePath)));
      } catch (parentError) {
        const parentFileError = parentError as NodeJS.ErrnoException;
        if (parentFileError.code !== 'ENOENT') {
          throw parentFileError;
        }
      }
    }

    const resolvedWorkspaceRoot = normalizeProjectPath(await realpath(WORKSPACES_ROOT));
    if (
      !resolvedPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
      && resolvedPath !== resolvedWorkspaceRoot
    ) {
      return {
        valid: false,
        error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}`,
      };
    }

    try {
      await access(absolutePath);
      const pathStats = await lstat(absolutePath);
      if (pathStats.isSymbolicLink()) {
        const symlinkTarget = await readlink(absolutePath);
        const resolvedSymlinkPath = path.resolve(path.dirname(absolutePath), symlinkTarget);
        const realSymlinkPath = await realpath(resolvedSymlinkPath);
        if (
          !realSymlinkPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
          && realSymlinkPath !== resolvedWorkspaceRoot
        ) {
          return {
            valid: false,
            error: 'Symlink target is outside the allowed workspace root',
          };
        }
      }
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }
    }

    return {
      valid: true,
      resolvedPath,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${(error as Error).message}`,
    };
  }
}

// ---------------------------
//----------------- NORMALIZED PROVIDER MESSAGE UTILITIES ------------
/**
 * Generates a stable unique id for normalized provider messages.
 */
export function generateMessageId(prefix = 'msg'): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Creates a normalized provider message and fills the shared envelope fields.
 *
 * Provider adapters and live SDK handlers pass through provider-specific fields,
 * while this helper guarantees every emitted event has an id, session id,
 * timestamp, and provider marker.
 */
export function createNormalizedMessage(fields: NormalizedMessageInput): NormalizedMessage {
  return {
    ...fields,
    id: fields.id || generateMessageId(fields.kind),
    sessionId: fields.sessionId || '',
    timestamp: fields.timestamp || new Date().toISOString(),
    provider: fields.provider,
  };
}

/**
 * Build the unified terminal `complete` lifecycle message.
 *
 * Contract: every provider run ends with exactly one `complete` (the
 * abort-session handler emits it on behalf of cancelled runs, so aborted runs
 * must NOT emit their own). The frontend treats `complete` as the only
 * terminal signal and never needs provider-specific handling:
 *
 * - `sessionId`     — the id the client knows this run by ('' if never discovered)
 * - `actualSessionId` — canonical id after the run; equals `sessionId` unless
 *                       the provider rewrote it mid-run
 * - `exitCode`      — 0 on success; a missing/null code (e.g. killed process)
 *                     is reported as failure
 * - `success`       — exitCode === 0 and not aborted
 * - `aborted`       — run was cancelled by the user
 */
export function createCompleteMessage(opts: {
  provider: NormalizedMessage['provider'];
  sessionId?: string | null;
  actualSessionId?: string | null;
  exitCode?: number | null;
  aborted?: boolean;
}): NormalizedMessage {
  const exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : 1;
  const aborted = Boolean(opts.aborted);

  return createNormalizedMessage({
    kind: 'complete',
    provider: opts.provider,
    sessionId: opts.sessionId || null,
    actualSessionId: opts.actualSessionId || opts.sessionId || null,
    exitCode,
    success: exitCode === 0 && !aborted,
    aborted,
  });
}

// ---------------------------
//----------------- SUBAGENT TIMELINE UTILITIES ------------
/**
 * Longest tool output kept on one subagent activity.
 *
 * A subagent's timeline is nested inside a collapsed panel, so it is a preview
 * of what the agent did, never the primary place its output is read. Sending
 * every child command's full output made the history payload of an
 * agent-heavy session grow by megabytes for content almost nobody expands.
 */
const MAX_SUBAGENT_ACTIVITY_CONTENT = 4000;

function truncateForPreview(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length <= MAX_SUBAGENT_ACTIVITY_CONTENT) {
    return value;
  }
  const omitted = value.length - MAX_SUBAGENT_ACTIVITY_CONTENT;
  return `${value.slice(0, MAX_SUBAGENT_ACTIVITY_CONTENT)}\n… ${omitted} more characters`;
}

/**
 * Trims one subagent activity down to what its nested preview can show.
 *
 * Used by both provider session adapters so a Claude agent's timeline and a
 * Codex agent's timeline cost the same to transport.
 */
export function truncateSubagentActivity(activity: SubagentActivity): SubagentActivity {
  const truncatedContent = truncateForPreview(activity.content);
  const truncatedResult = activity.toolResult
    ? { ...activity.toolResult, content: truncateForPreview(activity.toolResult.content) }
    : activity.toolResult;

  if (truncatedContent === activity.content && truncatedResult === activity.toolResult) {
    return activity;
  }

  return { ...activity, content: truncatedContent, toolResult: truncatedResult };
}

// ---------------------------
//----------------- CONVERSATION HISTORY PAGINATION UTILITIES ------------
/**
 * Slices one page from the END of a chronologically ordered message list.
 *
 * This is the single pagination contract for conversation history across all
 * providers: `offset = 0` returns the most recent `limit` items, increasing
 * offsets walk backwards in time (for "scroll up to load older" UIs), and a
 * `null` limit returns everything. Items must already be sorted oldest-first;
 * the returned page preserves that order.
 *
 * Every provider history reader must use this helper instead of slicing
 * manually so `offset`/`limit` query params behave identically regardless of
 * which provider produced the session.
 */
export function sliceTailPage<T>(
  items: T[],
  limit: number | null,
  offset: number,
): { page: T[]; hasMore: boolean } {
  const total = items.length;
  const normalizedOffset = Math.max(0, offset);

  if (limit === null) {
    // A null limit returns the full list; offset still trims newest entries
    // so "everything before the page I already have" stays expressible.
    const end = Math.max(0, total - normalizedOffset);
    return {
      page: items.slice(0, end),
      hasMore: false,
    };
  }

  const end = Math.max(0, total - normalizedOffset);
  const start = Math.max(0, end - Math.max(0, limit));
  return {
    page: items.slice(start, end),
    hasMore: start > 0,
  };
}

// ---------------------------
//----------------- MCP CONFIG PARSING UTILITIES ------------
/**
 * Complete set of Codex MCP default tool-approval policies accepted by the
 * provider route and TOML adapter. Keeping the runtime values here lets both
 * consumers share one allowlist while `server/shared/types.ts` stays type-only.
 */
export const CODEX_MCP_TOOLS_APPROVAL_MODES: readonly CodexMcpToolsApprovalMode[] = [
  'auto',
  'prompt',
  'writes',
  'approve',
];

/**
 * Narrows untrusted route or config data to a supported Codex MCP approval
 * policy. Provider routes use it for strict input validation; the Codex MCP
 * adapter uses it when normalizing manually edited TOML.
 */
export function isCodexMcpToolsApprovalMode(
  value: unknown,
): value is CodexMcpToolsApprovalMode {
  return typeof value === 'string'
    && CODEX_MCP_TOOLS_APPROVAL_MODES.includes(value as CodexMcpToolsApprovalMode);
}

/**
 * Safely narrows an unknown value to a plain object record.
 *
 * This deliberately rejects arrays, `null`, and primitive values so callers can
 * treat the returned value as a JSON-style object map without repeating the same
 * defensive shape checks at every config read site.
 */
export const readObjectRecord = (value: any): AnyRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as AnyRecord;
};

/**
 * Reads an optional string from unknown input and normalizes empty or whitespace-only
 * values to `undefined`.
 *
 * This is useful when parsing config files where a field may be missing, present
 * with the wrong type, or present as an empty string that should be treated as
 * "not configured".
 */
export const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

/**
 * Reads an optional string array from unknown input.
 *
 * Non-array values are ignored, and any array entries that are not strings are
 * filtered out. This lets provider config readers consume loosely shaped JSON/TOML
 * data without failing on incidental invalid members.
 */
export const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * Reads an optional string-to-string map from unknown input.
 *
 * The function first ensures the source value is a plain object, then keeps only
 * keys whose values are strings. If no valid entries remain, it returns `undefined`
 * so callers can distinguish "no usable map" from an empty object that was
 * intentionally authored downstream.
 */
export const readStringRecord = (value: unknown): Record<string, string> | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      normalized[key] = entry;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

// ---------------------------
//----------------- PROVIDER MODEL LOOKUP UTILITIES ------------
/**
 * Builds the standard "default current model" result used when a provider
 * cannot resolve a session-backed active model.
 *
 * Provider model adapters should call this after loading their supported model
 * catalog so the fallback stays aligned with the provider's current `DEFAULT`
 * selection instead of drifting to a hard-coded duplicate.
 */
export function buildDefaultProviderCurrentActiveModel(
  models: ProviderModelsDefinition,
): ProviderCurrentActiveModel {
  return {
    model: models.DEFAULT,
  };
}

// ---------------------------
//----------------- WEBSOCKET PAYLOAD PARSING UTILITIES ------------
/**
 * Parses one websocket message payload into a plain JSON object record.
 *
 * Use this in realtime handlers that receive raw websocket payloads as `string`,
 * `Buffer`, `ArrayBuffer`, or chunk arrays. The helper converts supported
 * payload formats to UTF-8 text, parses JSON, and returns only object payloads.
 * Primitive/array/invalid payloads return `null` so callers can handle bad input
 * without throwing from deeply nested message handlers.
 */
export const parseIncomingJsonObject = (payload: unknown): AnyRecord | null => {
  let text: string | null = null;

  if (typeof payload === 'string') {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString('utf8');
  } else if (payload instanceof ArrayBuffer) {
    text = Buffer.from(payload).toString('utf8');
  } else if (Array.isArray(payload)) {
    const buffers = payload
      .map((entry) => {
        if (Buffer.isBuffer(entry)) {
          return entry;
        }

        if (entry instanceof ArrayBuffer) {
          return Buffer.from(entry);
        }

        if (ArrayBuffer.isView(entry)) {
          return Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength);
        }

        return null;
      })
      .filter((entry): entry is Buffer => entry !== null);

    if (buffers.length > 0) {
      text = Buffer.concat(buffers).toString('utf8');
    }
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return readObjectRecord(parsed);
  } catch {
    return null;
  }
};

/**
 * Reads a JSON config file and guarantees a plain object result.
 *
 * Missing files are treated as an empty config object so provider-specific MCP
 * readers can operate against first-run environments without special-case file
 * existence checks. If the file exists but contains invalid JSON, the parse error
 * is preserved and rethrown.
 */
export const readJsonConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

/**
 * Writes a JSON config file with stable, human-readable formatting.
 *
 * The parent directory is created automatically so callers can persist config into
 * provider-specific folders without pre-creating the directory tree. Output always
 * ends with a trailing newline to keep the file diff-friendly.
 */
export const writeJsonConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

// ---------------------------
//----------------- PROVIDER SKILL FILE UTILITIES ------------
async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const gitMarkerStats = await stat(path.join(dirPath, '.git'));
    return gitMarkerStats.isDirectory() || gitMarkerStats.isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the highest git worktree root visible from a starting directory.
 *
 * Provider skill systems such as Codex and OpenCode walk upward through parent
 * folders when resolving repository/project skills. Use this helper when a
 * provider needs the topmost `.git` marker instead of only the nearest one, so
 * monorepos and nested package folders discover shared root-level skills once.
 */
export async function findTopmostGitRoot(startPath: string): Promise<string | null> {
  let currentPath = path.resolve(startPath);
  let topmostGitRoot: string | null = null;

  while (true) {
    if (await hasGitMarker(currentPath)) {
      topmostGitRoot = currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return topmostGitRoot;
}

/**
 * Adds one provider skill source after normalizing and de-duplicating its root.
 *
 * Provider skill lookup rules often point at overlapping folders (for example a
 * workspace folder can also be the git root). Use this helper while building a
 * provider's `ProviderSkillSource[]` so the shared skills scanner reads each
 * physical root once and still preserves provider-specific scope/command data.
 */
export function addUniqueProviderSkillSource(
  sources: ProviderSkillSource[],
  seenRootDirs: Set<string>,
  source: ProviderSkillSource,
): void {
  const normalizedRootDir = path.resolve(source.rootDir);
  if (seenRootDirs.has(normalizedRootDir)) {
    return;
  }

  seenRootDirs.add(normalizedRootDir);
  sources.push({ ...source, rootDir: normalizedRootDir });
}

// ---------------------------
//----------------- PROVIDER SKILL MARKDOWN UTILITIES ------------
/**
 * Finds direct child skill markdown files under a provider skill root.
 *
 * Skill systems usually store one skill per child directory, so direct mode
 * scans only `<root>/<skill-name>/SKILL.md`. Recursive mode is reserved for
 * provider sources that can nest skills arbitrarily, and it returns every
 * descendant `SKILL.md`. Missing or unreadable roots return an empty list
 * because users may not have every provider installed or configured.
 */
export async function findProviderSkillMarkdownFiles(
  rootDir: string,
  options: { recursive?: boolean } = {},
): Promise<string[]> {
  const skillFiles: string[] = [];

  const collectRecursive = async (dirPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    try {
      const skillPath = path.join(dirPath, 'SKILL.md');
      const skillStats = await stat(skillPath);
      if (skillStats.isFile()) {
        skillFiles.push(skillPath);
      }
    } catch {
      // Directories without SKILL.md are expected while walking plugin trees.
    }

    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await collectRecursive(path.join(dirPath, entry.name));
      }
    }
  };

  if (options.recursive) {
    await collectRecursive(rootDir);
    return skillFiles.sort((left, right) => left.localeCompare(right));
  }

  try {
    const entries = await readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
      try {
        const skillStats = await stat(skillPath);
        if (skillStats.isFile()) {
          skillFiles.push(skillPath);
        }
      } catch {
        // A partial skill directory should not block discovery of sibling skills.
      }
    }

    return skillFiles.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Reads the `name` and `description` fields from a provider skill markdown file.
 *
 * The metadata is expected in markdown front matter. If a skill omits `name`, the
 * parent directory name is used as a stable fallback so providers can still
 * expose the skill. Missing descriptions are normalized to an empty string.
 */
export async function readProviderSkillMarkdownDefinition(
  skillPath: string,
): Promise<{ name: string; description: string }> {
  const content = await readFile(skillPath, 'utf8');
  return readProviderSkillMarkdownDefinitionFromContent(
    content,
    path.basename(path.dirname(skillPath)),
  );
}

/**
 * Reads the `name` and `description` fields from raw skill markdown content.
 *
 * This keeps filesystem discovery and newly uploaded skill creation aligned on
 * the same front matter parsing rules. `fallbackName` is used when the markdown
 * omits a `name` field so callers still get a stable, non-empty skill id.
 */
export function readProviderSkillMarkdownDefinitionFromContent(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const parsed = parseFrontMatter(content);
  const data = readObjectRecord(parsed.data) ?? {};

  return {
    name: readOptionalString(data.name) ?? fallbackName,
    description: readOptionalString(data.description) ?? '',
  };
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER TITLE HELPERS ------------
/**
 * Produces a compact session title suitable for UI rendering and DB storage.
 *
 * Use this when converting provider-native names into a consistent title value.
 * The helper collapses repeated whitespace, trims the result, and truncates it
 * to 120 characters so every provider writes stable and bounded metadata.
 * If the normalized input is empty, it returns the supplied fallback title.
 */
export function normalizeSessionName(rawValue: string | undefined, fallback: string): string {
  const normalized = (rawValue ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 120);
}

// ---------------------------
//----------------- PROVIDER SESSION VALUE NORMALIZATION UTILITIES ------------
/**
 * Converts provider-native timestamps into ISO strings.
 *
 * Provider CLIs commonly persist epoch timestamps as milliseconds, seconds, or
 * already-formatted date strings. Use this helper when normalizing session
 * metadata or transcript events so every provider writes the same ISO timestamp
 * shape to API responses and database rows.
 */
export function normalizeProviderTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return normalizeProviderTimestamp(parsed);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

/**
 * Parses a JSON string or narrows an existing object into a plain record.
 *
 * Use this when provider databases store structured JSON inside text columns.
 * Invalid JSON, arrays, and primitive values return `null` so callers can skip
 * malformed optional metadata without hiding the rest of a session transcript.
 */
export function readJsonRecord(value: unknown): AnyRecord | null {
  if (typeof value !== 'string') {
    return readObjectRecord(value);
  }

  try {
    return readObjectRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

// ---------------------------
//----------------- OPENCODE SESSION STORAGE UTILITIES ------------
/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, part, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never store
 * it as a deletable transcript path for an individual app session row.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Decodes an OpenCode text payload that was persisted as a JSON string literal.
 *
 * OpenCode can store the first user prompt (and other text parts) as `"hello"`
 * instead of `hello`. Used by both the OpenCode session reader (transcript
 * history) and the OpenCode synchronizer (session titling) so a session name or
 * message body never surfaces with surrounding quote characters. Only fully
 * quoted, valid JSON string literals are unwrapped; ordinary prose that merely
 * happens to start/end with a quote is returned untouched.
 */
export function unwrapJsonStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

// ---------------------------
//----------------- SAFE DIRECTORY NAME UTILITIES ------------
/**
 * Validates that a user or provider supplied identifier can safely be treated
 * as one leaf directory name under an existing root folder.
 *
 * Use this before composing paths like `<root>/<session-id>/file.db>` to block
 * path traversal and accidental nested paths. The returned string is trimmed but
 * otherwise unchanged so callers can still match the provider's on-disk naming.
 */
export function sanitizeLeafDirectoryName(inputName: string, label = 'directory name'): string {
  const normalized = inputName.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  if (
    normalized.includes('..')
    || normalized.includes(path.posix.sep)
    || normalized.includes(path.win32.sep)
    || normalized !== path.basename(normalized)
  ) {
    throw new Error(`Invalid ${label} "${inputName}".`);
  }

  return normalized;
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER FILESYSTEM HELPERS ------------
/**
 * Recursively discovers files that match one extension, with optional incremental filtering.
 *
 * Provider synchronizers call this to find transcript artifacts under provider
 * home directories. Pass `lastScanAt` to include only files created after the
 * previous scan, or pass `null` to perform a full rescan. Missing directories
 * are treated as empty because not every provider exists on every machine.
 */
export async function findFilesRecursivelyCreatedAfter(
  rootDir: string,
  extension: string,
  lastScanAt: Date | null,
  fileList: string[] = []
): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isDirectory()) {
        await findFilesRecursivelyCreatedAfter(fullPath, extension, lastScanAt, fileList);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }

      if (!lastScanAt) {
        fileList.push(fullPath);
        continue;
      }

      const fileStat = await stat(fullPath);
      if (fileStat.birthtime > lastScanAt) {
        fileList.push(fullPath);
      }
    }
  } catch {
    // Missing provider folders are expected in first-run or partial setups.
  }

  return fileList;
}

/**
 * Reads file creation/update timestamps and maps them to DB-friendly ISO strings.
 *
 * Session indexers use this to persist `created_at` and `updated_at` metadata
 * when upserting sessions. If the file cannot be read, an empty object is
 * returned so indexing can continue for other files.
 */
export async function readFileTimestamps(
  filePath: string,
  expectedIdentity?: { device: number; inode: number },
): Promise<{ createdAt?: string; updatedAt?: string }> {
  // Synchronizers pass the device/inode captured while authenticating the
  // opening JSONL envelope.  Requiring the same identity here prevents a
  // pathname replacement between metadata validation and timestamp lookup
  // from making the indexer trust a different regular file.  Callers that
  // only have a canonical, non-index artifact may omit it and still receive
  // the helper's no-follow/fstat protections.
  const opened = await openProviderTranscriptReadHandle(filePath, expectedIdentity);
  if (!opened) {
    return {};
  }
  try {
    const fileStat = await opened.handle.stat();
    return {
      createdAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return {};
  } finally {
    await closeProviderTranscriptReadHandle(opened.handle);
  }
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER JSONL PARSING HELPERS ------------
/**
 * Builds a first-seen key/value lookup map from a JSONL file.
 *
 * Use this for provider index files where session id -> display name metadata
 * is stored line-by-line. The first value for each key wins, preserving the
 * earliest known label while avoiding repeated map overwrites.
 */
export async function buildLookupMap(
  filePath: string,
  keyField: string,
  valueField: string
): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const key = parsed[keyField];
      const value = parsed[valueField];

      if (typeof key === 'string' && typeof value === 'string' && !lookup.has(key)) {
        lookup.set(key, value);
      }
    }
  } catch {
    // Missing or unreadable lookup files should not block session sync.
  }

  return lookup;
}

/**
 * Reads a JSONL file and returns the first extracted payload that matches caller criteria.
 *
 * The caller supplies an `extractor` that validates provider-specific row
 * shapes. This helper centralizes line-by-line parsing and lets indexers stop
 * scanning as soon as one valid row is found.
 */
export async function extractFirstValidJsonlData<T>(
  filePath: string,
  extractor: (parsedJson: unknown) => T | null | undefined
): Promise<T | null> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed);
      const extracted = extractor(parsed);
      if (extracted) {
        lineReader.close();
        fileStream.close();
        return extracted;
      }
    }
  } catch {
    // Ignore malformed or missing artifacts so full scans keep progressing.
  }

  return null;
}

// ---------------------------
//----------------- CLI PROMPT ARGUMENT UTILITIES ------------
/**
 * Makes a prompt safe to pass as one CLI argument to `.cmd`-shimmed tools on
 * Windows (cursor-agent and opencode installed via npm-style shims).
 *
 * cmd.exe cannot carry newlines inside an argument: everything after the
 * first newline is silently dropped before the target CLI ever sees it, which
 * truncates multi-line prompts and any appended `<images_input>` block.
 * Collapsing newline runs to single spaces loses formatting but never loses
 * content, so runtimes should call this on win32 right before spawning.
 *
 * Used by the cursor and opencode spawn runtimes.
 */
export function flattenPromptForWindowsShell(prompt: string): string {
  if (process.platform !== 'win32' || typeof prompt !== 'string') {
    return prompt;
  }
  return prompt.replace(/\s*\r?\n\s*/g, ' ').trim();
}

// ---------------------------
//----------------- TERMINAL OUTPUT UTILITIES ------------
const ANSI_TERMINAL_STYLES = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
} as const;

/**
 * Applies the small, consistent ANSI style vocabulary used by backend
 * terminal output. The CLI and server bootstrap share these formatters so
 * status, warning, and startup messages use one implementation. Callers
 * should pass complete display strings and write the returned value directly
 * to stdout or stderr; the reset suffix prevents styling subsequent output.
 */
export const terminalTextStyles = {
  info: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.cyan}${text}${ANSI_TERMINAL_STYLES.reset}`,
  ok: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.green}${text}${ANSI_TERMINAL_STYLES.reset}`,
  warn: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  error: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  tip: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.blue}${text}${ANSI_TERMINAL_STYLES.reset}`,
  bright: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.bright}${text}${ANSI_TERMINAL_STYLES.reset}`,
  dim: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.dim}${text}${ANSI_TERMINAL_STYLES.reset}`,
};

// ---------------------------
//----------------- RUNTIME PATH RESOLUTION UTILITIES ------------
/**
 * Resolves the directory containing an ES module from `import.meta.url`.
 * Backend entrypoints and feature composition roots use this instead of
 * recreating CommonJS `__dirname` logic.
 */
export function getModuleDirectory(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Walks upward to the nearest `server` directory in either source or compiled
 * output. Callers use this stable anchor for server-relative resources.
 */
export function findServerRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;
  while (path.basename(currentDirectory) !== 'server') {
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(`Could not resolve the backend server root from "${startDirectory}".`);
    }
    currentDirectory = parentDirectory;
  }
  return currentDirectory;
}

/**
 * Resolves the application root from a source or `dist-server/server` path so
 * package-level resources work identically before and after compilation.
 */
export function findApplicationRoot(startDirectory: string): string {
  const serverRoot = findServerRoot(startDirectory);
  const parentDirectory = path.dirname(serverRoot);
  return path.basename(parentDirectory) === 'dist-server'
    ? path.dirname(parentDirectory)
    : parentDirectory;
}
