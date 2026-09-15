import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

type RegistrySubject = {
  provider_key?: unknown;
  binding_ref?: unknown;
  open_dingtalk_id?: unknown;
  stable_subject?: unknown;
  union_dingtalk_id?: unknown;
  subject_scope?: unknown;
  status?: unknown;
};

type RegistryPerson = {
  person_id?: unknown;
  display_name?: unknown;
  display_aliases?: unknown;
  status?: unknown;
  dingtalk?: { subjects?: unknown; open_dingtalk_id?: unknown; user_id?: unknown };
  vcs_identity_ids?: unknown;
  verification?: { status?: unknown };
};

type RegistryVcsIdentity = {
  vcs_identity_id?: unknown;
  provider?: unknown;
  account?: unknown;
  author_names?: unknown;
  emails?: unknown;
  ownership?: unknown;
  status?: unknown;
  owner_person_id?: unknown;
  attribution_mode?: unknown;
};

type IdentityRegistry = {
  schema_version?: unknown;
  people?: unknown;
  vcs_identities?: unknown;
};

type RuntimeSubjectBinding = {
  provider_key?: unknown;
  binding_ref?: unknown;
  subject?: unknown;
  external_subject?: unknown;
  stable_subject?: unknown;
  union_id?: unknown;
  open_id?: unknown;
  subject_scope?: unknown;
  status?: unknown;
};

type RuntimeBridgeSenderBinding = RuntimeSubjectBinding & {
  sender_id?: unknown;
  sender_scope?: unknown;
  namespace?: unknown;
  subject_type?: unknown;
  person_id?: unknown;
};

type IdentityRuntimeMap = {
  schema_version?: unknown;
  dingtalk_subjects?: unknown;
  subjects?: unknown;
  dingtalk_senders?: unknown;
};

/**
 * Callers that sit at an authentication/execution boundary may require the
 * registry even when the process environment did not set the legacy
 * `CLOUDCLI_IDENTITY_REGISTRY_REQUIRED` switch.  The option is deliberately
 * explicit so a local developer can keep using a stale/absent registry
 * snapshot without being treated as a managed deployment.
 */
export type IdentityRegistryOptions = {
  required?: boolean;
  /**
   * Allows an already authenticated DingTalk login to bind its stable subject
   * automatically when the login matches exactly one active registry person.
   * Matching is provider-agnostic (the linked project organizations are an
   * OR): a declared exact-provider binding wins, then registered DingTalk
   * identifiers, then a unique roster name or alias. Generic registry reads
   * keep this disabled.
   */
  allowAutomaticEnrollment?: boolean;
};

// The composition root fixes this once, before it starts accepting requests.
// Keeping the value here avoids importing the Auth module back into the
// collaboration repository (which would create a feature-module cycle), and
// prevents a later process.env edit from weakening a managed deployment.
let startupRegistryRequirement: boolean | undefined;

const READONLY_PROFILE_NAMES = new Set([
  'qa', 'readonly', 'read-only', 'qa-readonly', 'product-qa', 'product-qa-readonly',
]);

export type RegistryIdentityStatus = 'verified' | 'configured' | 'pending' | 'ambiguous' | 'legacy';

export type ResolvedDingTalkIdentity = {
  personId: string | null;
  displayName: string;
  identityStatus: RegistryIdentityStatus;
  providerKey: string;
  externalSubject: string;
  subjectScope: 'global' | 'provider';
  vcsIdentityIds: string[];
};

export type ResolveDingTalkBridgeInput = {
  providerKey: string;
  namespace: string;
  senderScope: 'open_dingtalk_id' | 'user_id' | 'union_id';
  senderId: string;
  displayName?: string;
};

type ResolveDingTalkInput = {
  providerKey: string;
  unionId?: string;
  openId?: string;
  displayName: string;
};

const registryPath = (): string | null => {
  const configured = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH?.trim();
  return configured ? path.resolve(configured) : null;
};

const registryRequired = (required?: boolean): boolean => {
  // Once a managed process has pinned `true`, no downstream helper may pass a
  // weaker option and reopen the legacy identity path. A local `false` pin is
  // still intentionally overridable by an explicit `true` for a focused
  // preflight/test, but never the other way around.
  if (startupRegistryRequirement === true) return true;
  if (required !== undefined) return required;
  if (startupRegistryRequirement !== undefined) return startupRegistryRequirement;
  if (process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED === '1') return true;

  // Keep standalone module consumers fail-closed too. The composition root
  // still pins this value at startup; this fallback only covers focused tests
  // and embedders that do not run server/index.ts.
  return (() => {
    const profile = [
      process.env.CLOUDCLI_DEPLOYMENT_PROFILE,
      process.env.DEPLOYMENT_PROFILE,
      process.env.CLOUDCLI_PROFILE,
      process.env.VITE_DEPLOYMENT_PROFILE,
    ].find((value) => typeof value === 'string' && value.trim())?.trim().toLowerCase();
    return READONLY_PROFILE_NAMES.has(profile ?? '')
      || Boolean(
        process.env.CLOUDCLI_DINGTALK_CREDENTIALS_FILE?.trim()
        || process.env.CLOUDCLI_DINGTALK_PUBLIC_ORIGIN?.trim()
        || ['1', 'true', 'yes', 'on'].includes(
          String(process.env.CLOUDCLI_REQUIRE_DINGTALK_AUTH ?? '').trim().toLowerCase(),
        ),
      );
  })();
};

/** Returns the startup-pinned (or legacy environment) registry requirement. */
export function isIdentityRegistryRequired(): boolean {
  return registryRequired();
}

const runtimeMapPath = (): string | null => {
  const configured = process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH?.trim();
  return configured ? path.resolve(configured) : null;
};

function readRegistry(options: IdentityRegistryOptions = {}): IdentityRegistry | null {
  const file = registryPath();
  if (!file) {
    if (registryRequired(options.required)) {
      throw new AppError('The project identity registry is required but not configured.', {
        code: 'IDENTITY_REGISTRY_NOT_CONFIGURED',
        statusCode: 503,
      });
    }
    return null;
  }

  let fileStat: ReturnType<typeof fs.lstatSync>;
  let fileDescriptor: number | null = null;
  try {
    // The registry controls authorization and attribution. Do not follow a
    // final-component symlink, and do not accept a file that another local
    // account can rewrite. The runtime map below carries secrets and is
    // stricter (0600), while this non-sensitive registry only requires that
    // group/other write bits are absent.
    fileStat = fs.lstatSync(file);
  } catch (error) {
    throw new AppError(`The project identity registry could not be read: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'IDENTITY_REGISTRY_INVALID',
      statusCode: 503,
    });
  }
  if (!fileStat.isFile() || (fileStat.mode & 0o022) !== 0) {
    throw new AppError('The project identity registry must be a regular file that is not writable by group or other users.', {
      code: 'IDENTITY_REGISTRY_PERMISSIONS',
      statusCode: 503,
    });
  }

  let parsed: IdentityRegistry;
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  try {
    // Use O_NOFOLLOW where the platform provides it, then validate the exact
    // descriptor after opening. The inode/device check also keeps platforms
    // without O_NOFOLLOW fail-closed if the path changes after lstat.
    fileDescriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fileDescriptor);
    if (!openedStat.isFile()
      || (openedStat.mode & 0o022) !== 0
      || openedStat.dev !== fileStat.dev
      || openedStat.ino !== fileStat.ino) {
      throw new Error('the protected file changed while it was being opened');
    }
  } catch (error) {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    throw new AppError(`The project identity registry could not be opened safely: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'IDENTITY_REGISTRY_PERMISSIONS',
      statusCode: 503,
    });
  }
  try {
    parsed = JSON.parse(fs.readFileSync(fileDescriptor as number, 'utf8')) as IdentityRegistry;
  } catch (error) {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    throw new AppError(`The project identity registry could not be read: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'IDENTITY_REGISTRY_INVALID',
      statusCode: 503,
    });
  }
  if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schema_version !== 1
    || !Array.isArray(parsed.people)
    || !Array.isArray(parsed.vcs_identities)) {
    throw new AppError('The project identity registry has an unsupported schema.', {
      code: 'IDENTITY_REGISTRY_INVALID',
      statusCode: 503,
    });
  }
  return parsed;
}

function readRuntimeSubjectBindings(kind: 'subjects' | 'senders' = 'subjects'): RuntimeSubjectBinding[] {
  const file = runtimeMapPath();
  if (!file) return [];
  let fileStat;
  let fileDescriptor: number | null = null;
  try {
    // Do not follow a symlink for a file that contains stable external
    // subjects. The deployment operator must provision the exact 0600 file
    // that CloudCLI is configured to read.
    fileStat = fs.lstatSync(file);
  } catch (error) {
    throw new AppError(`The identity runtime map could not be read: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'IDENTITY_RUNTIME_MAP_INVALID',
      statusCode: 503,
    });
  }
  if (!fileStat.isFile() || (fileStat.mode & 0o7777) !== 0o600) {
    throw new AppError('The identity runtime map must be a regular file with permissions 0600.', {
      code: 'IDENTITY_RUNTIME_MAP_PERMISSIONS',
      statusCode: 503,
    });
  }
  try {
    // Open the exact file descriptor with O_NOFOLLOW and validate it again
    // after opening. This closes the lstat -> readFile replacement window that
    // would otherwise let a same-host attacker swap in a different subject
    // map between the permission check and JSON parsing.
    const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    if (!noFollow) {
      throw new Error('O_NOFOLLOW is unavailable on this platform');
    }
    fileDescriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fileDescriptor);
    if (!openedStat.isFile()
      || (openedStat.mode & 0o7777) !== 0o600
      || openedStat.dev !== fileStat.dev
      || openedStat.ino !== fileStat.ino) {
      throw new Error('the protected file changed while it was being opened');
    }
  } catch (error) {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    throw new AppError(`The identity runtime map could not be opened safely: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'IDENTITY_RUNTIME_MAP_PERMISSIONS',
      statusCode: 503,
    });
  }
  let parsed: IdentityRuntimeMap;
  try {
    parsed = JSON.parse(fs.readFileSync(fileDescriptor as number, 'utf8')) as IdentityRuntimeMap;
  } catch (error) {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    throw new AppError(`The identity runtime map could not be parsed: ${error instanceof Error ? error.message : String(error)}`, {
      code: 'IDENTITY_RUNTIME_MAP_INVALID',
      statusCode: 503,
    });
  }
  if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema_version !== 1) {
    throw new AppError('The identity runtime map has an unsupported schema.', {
      code: 'IDENTITY_RUNTIME_MAP_INVALID',
      statusCode: 503,
    });
  }
  if (kind === 'senders' && parsed.dingtalk_senders !== undefined && !Array.isArray(parsed.dingtalk_senders)) {
    throw new AppError('The identity runtime map dingtalk_senders must be an array.', {
      code: 'IDENTITY_RUNTIME_MAP_INVALID', statusCode: 503,
    });
  }
  const entries = kind === 'senders'
    ? (Array.isArray(parsed.dingtalk_senders) ? parsed.dingtalk_senders : [])
    : (Array.isArray(parsed.dingtalk_subjects)
      ? parsed.dingtalk_subjects
      : Array.isArray(parsed.subjects) ? parsed.subjects : []);
  if (kind === 'subjects' && !Array.isArray(parsed.dingtalk_subjects) && !Array.isArray(parsed.subjects)) {
    throw new AppError('The identity runtime map must contain a dingtalk_subjects array.', {
      code: 'IDENTITY_RUNTIME_MAP_INVALID',
      statusCode: 503,
    });
  }
  if (entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new AppError('The identity runtime map contains an invalid DingTalk binding entry.', {
      code: 'IDENTITY_RUNTIME_MAP_INVALID',
      statusCode: 503,
    });
  }
  const bindings = entries as RuntimeSubjectBinding[];
  if (kind === 'senders') {
    const seen = new Set<string>();
    for (const entry of bindings as RuntimeBridgeSenderBinding[]) {
      const provider = asString(entry.provider_key);
      const namespace = asString(entry.namespace);
      const subjectType = asString(entry.subject_type);
      const subject = asString(entry.subject);
      const personId = asString(entry.person_id);
      const key = `${provider}\0${namespace}\0${subjectType}\0${subject}`;
      if (!provider || !namespace || !subject
        || !['open_dingtalk_id', 'user_id', 'union_id'].includes(subjectType)
        || !['pending', 'active', 'configured', 'verified'].includes(asString(entry.status))) {
        throw new AppError('The identity runtime map contains an invalid bridge sender binding.', {
          code: 'IDENTITY_RUNTIME_MAP_INVALID', statusCode: 503,
        });
      }
      if (asString(entry.status) === 'verified' && !personId) {
        throw new AppError('The identity runtime map contains a verified sender without a person_id.', {
          code: 'IDENTITY_RUNTIME_MAP_INVALID', statusCode: 503,
        });
      }
      if (seen.has(key)) {
        throw new AppError('The identity runtime map contains an ambiguous bridge sender.', {
          code: 'IDENTITY_RUNTIME_MAP_AMBIGUOUS', statusCode: 503,
        });
      }
      seen.add(key);
    }
    return bindings;
  }
  const seenBindings = new Set<string>();
  const seenSubjects = new Set<string>();
  for (const binding of bindings) {
    const providerKey = asString(binding.provider_key);
    const bindingRef = asString(binding.binding_ref);
    const subjects = [...new Set([
      binding.subject,
      binding.external_subject,
      binding.stable_subject,
      binding.union_id,
      binding.open_id,
    ].map(asString).filter(Boolean))];
    const subject = subjects[0] ?? '';
    if (!providerKey || !bindingRef || !subject) {
      throw new AppError('The identity runtime map contains an incomplete DingTalk binding.', {
        code: 'IDENTITY_RUNTIME_MAP_INVALID',
        statusCode: 503,
      });
    }
    const bindingKey = `${providerKey}\0${bindingRef}`;
    if (seenBindings.has(bindingKey) || subjects.some((value) => seenSubjects.has(`${providerKey}\0${value}`))) {
      throw new AppError('The identity runtime map contains an ambiguous DingTalk binding.', {
        code: 'IDENTITY_RUNTIME_MAP_AMBIGUOUS',
        statusCode: 503,
      });
    }
    seenBindings.add(bindingKey);
    subjects.forEach((value) => seenSubjects.add(`${providerKey}\0${value}`));
    const status = asString(binding.status).toLowerCase();
    if (!['active', 'verified', 'configured'].includes(status)) {
      throw new AppError('The identity runtime map contains an inactive DingTalk binding.', {
        code: 'IDENTITY_RUNTIME_MAP_INACTIVE',
        statusCode: 503,
      });
    }
    const scope = asString(binding.subject_scope).toLowerCase();
    if (scope && !['global', 'provider'].includes(scope)) {
      throw new AppError('The identity runtime map contains an invalid subject scope.', {
        code: 'IDENTITY_RUNTIME_MAP_INVALID',
        statusCode: 503,
      });
    }
  }
  return bindings;
}

const asString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const normalizedDisplayName = (value: unknown): string => asString(value).normalize('NFKC');

type AutomaticEnrollmentCandidate = {
  person: RegistryPerson;
  subject: RegistrySubject;
  bindingRef: string;
};

function findAutomaticEnrollmentCandidate(
  registry: IdentityRegistry,
  input: ResolveDingTalkInput,
): AutomaticEnrollmentCandidate | 'ambiguous' | null {
  const providerKey = input.providerKey.trim();
  const displayName = normalizedDisplayName(input.displayName);
  if (!providerKey) return null;

  const activePeople = (registry.people as RegistryPerson[])
    .filter((person) => asString(person.status).toLowerCase() === 'active'
      && Boolean(asString(person.person_id)));

  // 1) Exact provider binding declared in the registry (historical rule).
  if (displayName) {
    const providerCandidates = activePeople.flatMap((person) => {
      if (normalizedDisplayName(person.display_name) !== displayName) return [];
      return subjectsFor(person)
        .filter((subject) => asString(subject.provider_key) === providerKey
          && Boolean(asString(subject.binding_ref))
          && !['suspended', 'disabled'].includes(asString(subject.status).toLowerCase()))
        .map((subject) => ({
          person,
          subject,
          bindingRef: asString(subject.binding_ref),
        }));
    });
    if (providerCandidates.length === 1) return providerCandidates[0];
    if (providerCandidates.length > 1) return 'ambiguous';
  }

  // The two project organizations are linked, so the same person may log in
  // through either provider. Below this point matching is provider-agnostic
  // and the binding_ref for the actual login provider is synthesized.
  const synthesizedCandidate = (person: RegistryPerson): AutomaticEnrollmentCandidate => {
    const bindingRef = `dingtalk-subject/${asString(person.person_id)}/${providerKey}`;
    return {
      person,
      subject: { provider_key: providerKey, binding_ref: bindingRef, status: 'runtime_configured' },
      bindingRef,
    };
  };

  // 2) Registered DingTalk identifiers prove the person regardless of the
  // login provider (person-level open_dingtalk_id / user_id, or per-subject
  // union/open IDs recorded for another provider).
  const loginIds = [input.unionId?.trim(), input.openId?.trim()].filter(Boolean) as string[];
  if (loginIds.length > 0) {
    const idMatches = activePeople.filter((person) => {
      const dingtalk = (person.dingtalk ?? {}) as { open_dingtalk_id?: unknown; user_id?: unknown };
      const registeredIds = [
        asString(dingtalk.open_dingtalk_id),
        asString(dingtalk.user_id),
        ...subjectsFor(person).flatMap((subject) => [
          asString(subject.union_dingtalk_id),
          asString(subject.open_dingtalk_id),
        ]),
      ].filter(Boolean);
      return registeredIds.some((value) => loginIds.includes(value));
    });
    if (idMatches.length === 1) return synthesizedCandidate(idMatches[0]);
    if (idMatches.length > 1) return 'ambiguous';
  }

  // 3) Unique roster name or registered alias, provider-agnostic.
  if (!displayName) return null;
  const nameMatches = activePeople.filter((person) => {
    if (normalizedDisplayName(person.display_name) === displayName) return true;
    const aliases = Array.isArray(person.display_aliases) ? person.display_aliases : [];
    return aliases.some((alias) => normalizedDisplayName(alias) === displayName);
  });
  if (nameMatches.length === 1) return synthesizedCandidate(nameMatches[0]);
  if (nameMatches.length > 1) return 'ambiguous';
  return null;
}

function writeAutomaticRuntimeBinding(input: {
  providerKey: string;
  bindingRef: string;
  externalSubject: string;
  subjectScope: 'global' | 'provider';
}): 'ready' | 'conflict' | 'unavailable' {
  const file = runtimeMapPath();
  if (!file) return 'unavailable';

  const initialStat = fs.lstatSync(file);
  const bridgeSenderBindings = readRuntimeSubjectBindings('senders');
  const bindings = readRuntimeSubjectBindings();
  const subjectMatch = bindings.find((binding) =>
    asString(binding.provider_key) === input.providerKey
    && [
      binding.subject,
      binding.external_subject,
      binding.stable_subject,
      binding.union_id,
      binding.open_id,
    ].map(asString).includes(input.externalSubject));
  const bindingMatch = bindings.find((binding) =>
    asString(binding.provider_key) === input.providerKey
    && asString(binding.binding_ref) === input.bindingRef);

  if ((subjectMatch && asString(subjectMatch.binding_ref) !== input.bindingRef)
    || (bindingMatch && ![
      bindingMatch.subject,
      bindingMatch.external_subject,
      bindingMatch.stable_subject,
      bindingMatch.union_id,
      bindingMatch.open_id,
    ].map(asString).includes(input.externalSubject))) {
    return 'conflict';
  }

  const existing = subjectMatch ?? bindingMatch;
  if (existing && ['active', 'verified'].includes(asString(existing.status).toLowerCase())) {
    return 'ready';
  }

  const parent = path.dirname(file);
  const parentStat = fs.lstatSync(parent);
  const currentUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o7777) !== 0o700
    || (currentUid !== null && parentStat.uid !== currentUid)) {
    throw new AppError('The identity runtime map parent must be an account-owned 0700 directory.', {
      code: 'IDENTITY_RUNTIME_MAP_PERMISSIONS',
      statusCode: 503,
    });
  }

  const nextBindings = existing
    ? bindings.map((binding) => binding === existing ? { ...binding, status: 'active' } : binding)
    : [...bindings, {
        provider_key: input.providerKey,
        binding_ref: input.bindingRef,
        subject: input.externalSubject,
        subject_scope: input.subjectScope,
        status: 'active',
      }];
  const temporaryPath = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fileDescriptor: number | null = null;
  try {
    const currentStat = fs.lstatSync(file);
    if (currentStat.dev !== initialStat.dev || currentStat.ino !== initialStat.ino) {
      throw new Error('the protected runtime map changed during automatic enrollment');
    }
    const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fileDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fileDescriptor, `${JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: nextBindings,
      ...(bridgeSenderBindings.length ? { dingtalk_senders: bridgeSenderBindings } : {}),
    }, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.chmodSync(temporaryPath, 0o600);

    const beforeReplace = fs.lstatSync(file);
    if (beforeReplace.dev !== initialStat.dev || beforeReplace.ino !== initialStat.ino) {
      throw new Error('the protected runtime map changed before automatic enrollment was saved');
    }
    fs.renameSync(temporaryPath, file);
    const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
    return 'ready';
  } catch {
    throw new AppError('The automatic DingTalk identity binding could not be saved.', {
      code: 'IDENTITY_RUNTIME_MAP_WRITE_FAILED',
      statusCode: 503,
    });
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      // Cleanup failure must not replace the stable enrollment error. The
      // temporary file remains account-private (0600); report cleanup failure
      // without leaking its path or overriding the enrollment result.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        console.warn('Unable to remove temporary identity runtime map file.');
      }
    }
  }
}

const subjectsFor = (person: RegistryPerson): RegistrySubject[] =>
  Array.isArray(person.dingtalk?.subjects)
    ? person.dingtalk.subjects.filter((subject): subject is RegistrySubject => Boolean(subject && typeof subject === 'object'))
    : [];

const statusForPerson = (
  person: RegistryPerson,
  subject: RegistrySubject,
  runtimeSubjectVerified = true,
): RegistryIdentityStatus => {
  const subjectStatus = asString(subject.status).toLowerCase();
  const personStatus = asString(person.status).toLowerCase();
  if (personStatus !== 'active') return 'pending';
  // A binding_ref is only an index into the protected runtime map. A map row
  // that is merely configured has not completed automatic enrollment. Once
  // the protected map contains an active stable-subject binding, an active
  // roster entry is enough: identity registration is attribution, not a
  // second permission-approval workflow.
  if (!runtimeSubjectVerified) return 'configured';
  if (asString(subject.binding_ref)
    && !['suspended', 'disabled'].includes(subjectStatus)) return 'verified';
  const personVerificationStatus = asString(person.verification?.status).toLowerCase();
  if (subjectStatus === 'verified' && personVerificationStatus === 'verified') return 'verified';
  if (subjectStatus === 'runtime_configured' || subjectStatus === 'configured') return 'configured';
  return 'pending';
};

const identityStatusRank = (status: RegistryIdentityStatus): number => {
  switch (status) {
    case 'verified': return 3;
    case 'configured': return 2;
    case 'ambiguous': return 1;
    case 'pending': return 1;
    case 'legacy': return 0;
  }
};

/**
 * Reads the coordination repository's identity registry for trusted OAuth
 * subject and shared-VCS resolution. A display name is used only once, after
 * successful DingTalk allowlist authentication, to create a protected stable
 * subject binding when it matches exactly one active registry person.
 */
export const identityRegistryService = {
  assertConfiguration(options: IdentityRegistryOptions = {}): void {
    const registry = readRegistry(options);
    // Loading validates the path, permissions and JSON before the first OAuth
    // request. Binding-ref registries require the protected runtime map; a
    // raw-subject fixture without binding refs remains usable for migrations.
    const runtimeBindings = readRuntimeSubjectBindings();
    const hasBindingReferences = Boolean(registry && (registry.people as RegistryPerson[])
      .some((person) => subjectsFor(person).some((subject) => asString(subject.binding_ref))));
    if (hasBindingReferences && !runtimeMapPath()) {
      throw new AppError('The identity runtime map is required when binding_ref entries are configured.', {
        code: 'IDENTITY_RUNTIME_MAP_NOT_CONFIGURED',
        statusCode: 503,
      });
    }
    if (registry) {
      const registeredBindings = new Set(
        (registry.people as RegistryPerson[]).flatMap((person) => subjectsFor(person).map((subject) =>
          `${asString(subject.provider_key)}\0${asString(subject.binding_ref)}`,
        )),
      );
      for (const binding of runtimeBindings) {
        const key = `${asString(binding.provider_key)}\0${asString(binding.binding_ref)}`;
        if (!registeredBindings.has(key)) {
          throw new AppError('The identity runtime map references an unknown project binding.', {
            code: 'IDENTITY_RUNTIME_MAP_INVALID',
            statusCode: 503,
          });
        }
      }
    }
    if (process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID?.trim()
      || process.env.CLOUDCLI_SHARED_GIT_NAME?.trim()
      || process.env.CLOUDCLI_SHARED_GIT_EMAIL?.trim()) {
      // Startup only verifies that the configured shared identity is declared
      // and not suspended. Write/commit admission keeps the stricter default
      // (verified), so a newly deployed registry can remain available in
      // read-only mode while the owner completes confirmation.
      if (!this.getSharedGitIdentity({ requireVerified: false, required: options.required })) {
        throw new AppError('A shared Git identity is configured but no active declared shared identity exists in the registry.', {
          code: 'SHARED_GIT_IDENTITY_INVALID',
          statusCode: 503,
        });
      }
    }
  },

  isConfigured(options: IdentityRegistryOptions = {}): boolean {
    return registryPath() !== null || registryRequired(options.required);
  },

  /** Resolve a bridge sender through the separately namespaced sender map. */
  resolveDingTalkBridgeIdentity(
    input: ResolveDingTalkBridgeInput,
    options: IdentityRegistryOptions = {},
  ): ResolvedDingTalkIdentity {
    const registry = readRegistry(options);
    const senderId = input.senderId.trim();
    const providerKey = input.providerKey.trim();
    const namespace = input.namespace.trim();
    if (!registry || !senderId || !providerKey || !namespace) {
      return {
        personId: null,
        displayName: input.displayName?.trim() || '钉钉用户',
        identityStatus: 'pending',
        providerKey,
        externalSubject: senderId,
        subjectScope: 'provider',
        vcsIdentityIds: [],
      };
    }
    const bindings = readRuntimeSubjectBindings('senders');
    const matches = bindings.filter((binding) => {
      const sender = binding as RuntimeBridgeSenderBinding;
      return asString(sender.provider_key) === providerKey
        && asString(sender.namespace) === namespace
        && asString(sender.subject) === senderId
        && asString(sender.subject_type) === input.senderScope
        && !['suspended', 'disabled'].includes(asString(sender.status).toLowerCase());
    });
    if (matches.length !== 1) {
      return {
        personId: null,
        displayName: input.displayName?.trim() || '钉钉用户',
        identityStatus: matches.length > 1 ? 'ambiguous' : 'pending',
        providerKey,
        externalSubject: senderId,
        subjectScope: 'provider',
        vcsIdentityIds: [],
      };
    }
    const senderBinding = matches[0] as RuntimeBridgeSenderBinding;
    const person = (registry.people as RegistryPerson[]).find((entry) =>
      asString(entry.person_id) === asString(senderBinding.person_id)
      && asString(entry.status).toLowerCase() === 'active');
    if (!person) {
      return {
        personId: null,
        displayName: input.displayName?.trim() || '钉钉用户',
        identityStatus: 'pending',
        providerKey,
        externalSubject: senderId,
        subjectScope: 'provider',
        vcsIdentityIds: [],
      };
    }
    const status = asString(matches[0]?.status).toLowerCase();
    const identityStatus: RegistryIdentityStatus = status === 'verified'
      ? 'verified' : status === 'pending' ? 'pending' : 'configured';
    return {
      personId: identityStatus === 'verified' ? asString(person.person_id) : null,
      displayName: asString(person.display_name) || input.displayName?.trim() || '钉钉用户',
      identityStatus,
      providerKey,
      externalSubject: senderId,
      subjectScope: 'provider',
      vcsIdentityIds: Array.isArray(person.vcs_identity_ids)
        ? person.vcs_identity_ids.map(asString).filter(Boolean)
        : [],
    };
  },

  resolveDingTalkIdentity(
    input: ResolveDingTalkInput,
    options: IdentityRegistryOptions = {},
  ): ResolvedDingTalkIdentity | null {
    const registry = readRegistry(options);
    if (!registry) return null;
    const runtimeBindings = readRuntimeSubjectBindings();
    const people = registry.people as RegistryPerson[];
    const candidatesByPerson = new Map<string, {
      person: RegistryPerson;
      subject: RegistrySubject;
      externalSubject: string;
      subjectScope: 'global' | 'provider';
      identityStatus: RegistryIdentityStatus;
      runtimeSubjectVerified: boolean;
    }>();
    const providerKey = input.providerKey.trim();
    const subjects = [input.unionId?.trim(), input.openId?.trim()].filter(Boolean) as string[];

    for (const person of people) {
      for (const subject of subjectsFor(person)) {
        if (asString(subject.provider_key) !== providerKey) continue;
        const configuredValues = [
          asString(subject.stable_subject),
          asString(subject.union_dingtalk_id),
          asString(subject.open_dingtalk_id),
        ].filter(Boolean);
        const bindingRef = asString(subject.binding_ref);
        let runtimeSubjectScope: 'global' | 'provider' | undefined;
        let runtimeSubjectVerified = !bindingRef;
        if (bindingRef) {
          for (const runtimeBinding of runtimeBindings) {
            if (asString(runtimeBinding.binding_ref) !== bindingRef
              || asString(runtimeBinding.provider_key) !== providerKey
              || ['suspended', 'disabled'].includes(asString(runtimeBinding.status).toLowerCase())) {
              continue;
            }
            const runtimeValues = [
              asString(runtimeBinding.subject),
              asString(runtimeBinding.external_subject),
              asString(runtimeBinding.stable_subject),
              asString(runtimeBinding.union_id),
              asString(runtimeBinding.open_id),
            ].filter(Boolean);
            configuredValues.push(...runtimeValues);
            const runtimeStatus = asString(runtimeBinding.status).toLowerCase();
            if (runtimeValues.some((value) => subjects.includes(value))) {
              const scope = asString(runtimeBinding.subject_scope).toLowerCase();
              runtimeSubjectScope = scope === 'global' || scope === 'provider' ? scope : undefined;
              runtimeSubjectVerified = ['active', 'verified'].includes(runtimeStatus);
            }
          }
        }
        const matched = subjects.find((value) => configuredValues.includes(value));
        if (!matched) continue;
        const explicitlyGlobal = asString(subject.subject_scope).toLowerCase() === 'global';
        const identityStatus = statusForPerson(person, subject, runtimeSubjectVerified);
        // OAuth returns both unionId and openId in many deployments. A person
        // may also have multiple registered subjects (for example after an
        // organization migration). Treat matches for the same person as one
        // candidate, preferring the strongest verified subject, while keeping
        // different person_ids ambiguous.
        const personKey = asString(person.person_id) || `${providerKey}\0${matched}`;
        const subjectScope: 'global' | 'provider' = runtimeSubjectScope
          ?? (explicitlyGlobal || matched === input.unionId
          ? 'global'
          : 'provider');
        const candidate = {
          person,
          subject,
          externalSubject: matched,
          subjectScope,
          identityStatus,
          runtimeSubjectVerified,
        };
        const previous = candidatesByPerson.get(personKey);
        if (!previous || identityStatusRank(identityStatus) > identityStatusRank(previous.identityStatus)) {
          candidatesByPerson.set(personKey, candidate);
        }
      }
    }

    // Runtime bindings whose binding_ref names a registered person directly
    // (synthesized by automatic enrollment or written by an operator for a
    // provider the registry does not model explicitly) still resolve: the
    // protected map is authoritative for subject → person, the registry for
    // person metadata. Registry-modeled subjects already produced candidates
    // above and win via the person-key dedupe.
    for (const runtimeBinding of runtimeBindings) {
      if (asString(runtimeBinding.provider_key) !== providerKey) continue;
      const runtimeStatus = asString(runtimeBinding.status).toLowerCase();
      if (['suspended', 'disabled'].includes(runtimeStatus)) continue;
      const runtimeValues = [
        asString(runtimeBinding.subject),
        asString(runtimeBinding.external_subject),
        asString(runtimeBinding.stable_subject),
        asString(runtimeBinding.union_id),
        asString(runtimeBinding.open_id),
      ].filter(Boolean);
      const matched = subjects.find((value) => runtimeValues.includes(value));
      if (!matched) continue;
      const bindingRef = asString(runtimeBinding.binding_ref);
      const refParts = bindingRef.split('/');
      if (refParts[0] !== 'dingtalk-subject' || !refParts[1]) continue;
      const person = people.find((value) => asString(value.person_id) === refParts[1]);
      if (!person || asString(person.status).toLowerCase() !== 'active') continue;
      const personKey = asString(person.person_id);
      if (candidatesByPerson.has(personKey)) continue;
      const runtimeSubjectVerified = ['active', 'verified'].includes(runtimeStatus);
      const pseudoSubject: RegistrySubject = {
        provider_key: providerKey,
        binding_ref: bindingRef,
        status: 'runtime_configured',
      };
      const scope = asString(runtimeBinding.subject_scope).toLowerCase();
      candidatesByPerson.set(personKey, {
        person,
        subject: pseudoSubject,
        externalSubject: matched,
        subjectScope: scope === 'global' || scope === 'provider'
          ? scope
          : (matched === input.unionId ? 'global' : 'provider'),
        identityStatus: statusForPerson(person, pseudoSubject, runtimeSubjectVerified),
        runtimeSubjectVerified,
      });
    }

    const candidates = [...candidatesByPerson.values()];
    if (candidates.length === 0 && options.allowAutomaticEnrollment) {
      const automaticCandidate = findAutomaticEnrollmentCandidate(registry, input);
      if (automaticCandidate === 'ambiguous') {
        return {
          personId: null,
          displayName: input.displayName,
          identityStatus: 'ambiguous',
          providerKey,
          externalSubject: input.unionId?.trim() || input.openId?.trim() || '',
          subjectScope: input.unionId ? 'global' : 'provider',
          vcsIdentityIds: [],
        };
      }
      const externalSubject = input.unionId?.trim() || input.openId?.trim() || '';
      if (automaticCandidate && externalSubject) {
        let writeResult: ReturnType<typeof writeAutomaticRuntimeBinding> = 'unavailable';
        try {
          writeResult = writeAutomaticRuntimeBinding({
            providerKey,
            bindingRef: automaticCandidate.bindingRef,
            externalSubject,
            subjectScope: input.unionId ? 'global' : 'provider',
          });
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'IDENTITY_RUNTIME_MAP_WRITE_FAILED';
          console.warn('[IdentityRegistry] Automatic DingTalk enrollment was skipped.', { code });
        }
        if (writeResult === 'conflict') {
          return {
            personId: null,
            displayName: input.displayName,
            identityStatus: 'ambiguous',
            providerKey,
            externalSubject,
            subjectScope: input.unionId ? 'global' : 'provider',
            vcsIdentityIds: [],
          };
        }
        if (writeResult === 'ready') {
          const personId = asString(automaticCandidate.person.person_id);
          return {
            personId,
            displayName: asString(automaticCandidate.person.display_name) || input.displayName,
            identityStatus: 'verified',
            providerKey,
            externalSubject,
            subjectScope: input.unionId ? 'global' : 'provider',
            vcsIdentityIds: Array.isArray(automaticCandidate.person.vcs_identity_ids)
              ? automaticCandidate.person.vcs_identity_ids.map(asString).filter(Boolean)
              : [],
          };
        }
      }
    }
    if (candidates.length !== 1) {
      return {
        personId: null,
        displayName: input.displayName,
        identityStatus: candidates.length > 1 ? 'ambiguous' : 'pending',
        providerKey,
        externalSubject: input.unionId?.trim() || input.openId?.trim() || '',
        subjectScope: input.unionId ? 'global' : 'provider',
        vcsIdentityIds: [],
      };
    }

    const [{ person, subject, externalSubject, subjectScope, runtimeSubjectVerified }] = candidates;
    const identityStatus = statusForPerson(person, subject, runtimeSubjectVerified);
    // A known-but-unverified or suspended subject is not a trusted project
    // attribution. Keep the display label for the enrollment screen, but do
    // not attach its person_id to the actor until verification is complete.
    const personId = identityStatus === 'verified' ? asString(person.person_id) : '';
    return {
      personId: personId || null,
      displayName: asString(person.display_name) || input.displayName,
      identityStatus,
      providerKey,
      externalSubject,
      subjectScope,
      vcsIdentityIds: Array.isArray(person.vcs_identity_ids)
        ? person.vcs_identity_ids.map(asString).filter(Boolean)
        : [],
    };
  },

  /** Returns the one shared Git identity declared for CloudCLI, if present. */
  getSharedGitIdentity(options: { requireVerified?: boolean; required?: boolean } = {}): {
    id: string;
    name: string;
    email: string;
  } | null {
    const registry = readRegistry({ required: options.required });
    if (!registry) return null;
    const requireVerified = options.requireVerified !== false;
    const allowedStatuses = requireVerified ? ['verified'] : ['verified', 'configured', 'observed'];
    const identities = (registry.vcs_identities as RegistryVcsIdentity[])
      .filter((identity) => asString(identity.ownership) === 'shared'
        && identity.owner_person_id == null
        && asString(identity.attribution_mode) === 'session_actor_required'
        && allowedStatuses.includes(asString(identity.status))
        && asString(identity.status) !== 'suspended');
    const configuredId = process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID?.trim();
    if (identities.length !== 1) {
      if (identities.length > 1 && configuredId) {
        const selected = identities.find((identity) => asString(identity.vcs_identity_id) === configuredId);
        if (!selected) throw new AppError('Configured shared Git identity is not in the identity registry.', { code: 'SHARED_GIT_IDENTITY_INVALID', statusCode: 503 });
        return this.sharedIdentityFromRow(selected);
      }
      if (identities.length > 1) throw new AppError('The identity registry contains multiple shared Git identities.', { code: 'SHARED_GIT_IDENTITY_AMBIGUOUS', statusCode: 503 });
      return null;
    }
    if (configuredId && configuredId !== asString(identities[0].vcs_identity_id)) {
      throw new AppError('Configured shared Git identity is not in the identity registry.', { code: 'SHARED_GIT_IDENTITY_INVALID', statusCode: 503 });
    }
    return this.sharedIdentityFromRow(identities[0]);
  },

  /** Resolve a personal Git identity linked from one registered person. */
  getPersonalGitIdentity(personId: string): {
    id: string;
    name: string;
    email: string;
  } | null {
    const registry = readRegistry();
    if (!registry) return null;
    const person = (registry.people as RegistryPerson[]).find((entry) => asString(entry.person_id) === personId);
    if (!person || !Array.isArray(person.vcs_identity_ids)) return null;
    const ids = person.vcs_identity_ids.map(asString).filter(Boolean);
    const candidates = (registry.vcs_identities as RegistryVcsIdentity[]).filter((identity) =>
      ids.includes(asString(identity.vcs_identity_id))
      && asString(identity.ownership) === 'personal'
      && asString(identity.owner_person_id) === personId
      && asString(identity.status) === 'verified',
    );
    if (candidates.length > 1) {
      throw new AppError('The project person is linked to multiple personal Git identities.', {
        code: 'PERSONAL_GIT_IDENTITY_AMBIGUOUS',
        statusCode: 503,
      });
    }
    return candidates.length === 1 ? this.personalIdentityFromRow(candidates[0]) : null;
  },

  /** Resolves a registry row into the values Git must receive per execution. */
  sharedIdentityFromRow(identity: RegistryVcsIdentity): { id: string; name: string; email: string } {
    const id = asString(identity.vcs_identity_id);
    const names = Array.isArray(identity.author_names) ? identity.author_names.map(asString).filter(Boolean) : [];
    const emails = Array.isArray(identity.emails) ? identity.emails.map(asString).filter(Boolean) : [];
    const configuredName = process.env.CLOUDCLI_SHARED_GIT_NAME?.trim();
    const configuredEmail = process.env.CLOUDCLI_SHARED_GIT_EMAIL?.trim();
    if (configuredName && !names.includes(configuredName)) {
      throw new AppError('Configured shared Git name is not registered.', { code: 'SHARED_GIT_IDENTITY_INVALID', statusCode: 503 });
    }
    if (configuredEmail && !emails.includes(configuredEmail)) {
      throw new AppError('Configured shared Git email is not registered.', { code: 'SHARED_GIT_IDENTITY_INVALID', statusCode: 503 });
    }
    const name = configuredName || names[0] || '';
    const email = configuredEmail || emails[0] || '';
    if (!id || !name || !email) throw new AppError('The shared Git identity is incomplete.', { code: 'SHARED_GIT_IDENTITY_INVALID', statusCode: 503 });
    return { id, name, email };
  },

  personalIdentityFromRow(identity: RegistryVcsIdentity): { id: string; name: string; email: string } {
    const id = asString(identity.vcs_identity_id);
    const names = Array.isArray(identity.author_names) ? identity.author_names.map(asString).filter(Boolean) : [];
    const emails = Array.isArray(identity.emails) ? identity.emails.map(asString).filter(Boolean) : [];
    if (!id || !names[0] || !emails[0]) {
      throw new AppError('The personal Git identity is incomplete.', { code: 'PERSONAL_GIT_IDENTITY_INVALID', statusCode: 503 });
    }
    return { id, name: names[0], email: emails[0] };
  },
};

/**
 * Pins whether the running deployment requires the project identity registry.
 * The server composition root calls this exactly once after resolving its
 * startup auth policy. Standalone tests/embedders can omit it and retain the
 * environment-variable behavior above; a conflicting second pin throws
 * rather than silently weakening an already managed process.
 */
export function configureIdentityRegistryRequirement(required: boolean): void {
  if (startupRegistryRequirement !== undefined && startupRegistryRequirement !== required) {
    throw new AppError('The project identity registry requirement cannot change after startup.', {
      code: 'IDENTITY_REGISTRY_POLICY_IMMUTABLE',
      statusCode: 500,
    });
  }
  startupRegistryRequirement = required;
}
