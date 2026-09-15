import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { identityRegistryService } from '@/modules/collaboration/identity-registry.service.js';

const originalPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
const originalRequired = process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
const originalSharedId = process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID;
const originalSharedName = process.env.CLOUDCLI_SHARED_GIT_NAME;
const originalSharedEmail = process.env.CLOUDCLI_SHARED_GIT_EMAIL;
const originalRuntimeMapPath = process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH;

async function withRegistry(run: () => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-registry-'));
  const file = path.join(directory, 'identities.json');
  await writeFile(file, JSON.stringify({
    schema_version: 1,
    people: [
      {
        person_id: 'alice',
        display_name: '张三',
        status: 'active',
        verification: { status: 'verified' },
        dingtalk: {
          subjects: [
            { provider_key: 'comic', union_dingtalk_id: 'union-1', status: 'verified' },
            { provider_key: 'comic', open_dingtalk_id: 'open-1', status: 'configured' },
          ],
        },
        vcs_identity_ids: ['vcs-shared'],
      },
      {
        person_id: 'bob',
        display_name: '李四',
        status: 'active',
        verification: { status: 'verified' },
        dingtalk: { subjects: [{ provider_key: 'comic', union_dingtalk_id: 'bob-union', status: 'verified' }] },
        vcs_identity_ids: ['vcs-personal'],
      },
    ],
    vcs_identities: [
      {
        vcs_identity_id: 'vcs-shared',
        provider: 'github',
        account: 'shared',
        author_names: ['shared-bot'],
        emails: ['shared@example.com'],
        ownership: 'shared',
        owner_person_id: null,
        attribution_mode: 'session_actor_required',
        status: 'verified',
      },
      {
        vcs_identity_id: 'vcs-personal',
        provider: 'github',
        account: 'bob',
        author_names: ['bob'],
        emails: ['bob@example.com'],
        ownership: 'personal',
        owner_person_id: 'bob',
        attribution_mode: 'vcs_identity',
        status: 'verified',
      },
    ],
  }), { encoding: 'utf8', mode: 0o644 });
  process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = file;
  process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = '1';
  delete process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID;
  delete process.env.CLOUDCLI_SHARED_GIT_NAME;
  delete process.env.CLOUDCLI_SHARED_GIT_EMAIL;
  delete process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH;
  try {
    await run();
  } finally {
    if (originalPath === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = originalPath;
    if (originalRequired === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = originalRequired;
    if (originalSharedId === undefined) delete process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID;
    else process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID = originalSharedId;
    if (originalSharedName === undefined) delete process.env.CLOUDCLI_SHARED_GIT_NAME;
    else process.env.CLOUDCLI_SHARED_GIT_NAME = originalSharedName;
    if (originalSharedEmail === undefined) delete process.env.CLOUDCLI_SHARED_GIT_EMAIL;
    else process.env.CLOUDCLI_SHARED_GIT_EMAIL = originalSharedEmail;
    if (originalRuntimeMapPath === undefined) delete process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH;
    else process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = originalRuntimeMapPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('resolves a stable DingTalk subject and the shared Git identity', async () => {
  await withRegistry(() => {
    const identity = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'union-1',
      displayName: '伪造名称',
    });
    assert.equal(identity?.personId, 'alice');
    assert.equal(identity?.displayName, '张三');
    assert.equal(identity?.identityStatus, 'verified');
    assert.deepEqual(identity?.vcsIdentityIds, ['vcs-shared']);
    assert.deepEqual(identityRegistryService.getSharedGitIdentity(), {
      id: 'vcs-shared',
      name: 'shared-bot',
      email: 'shared@example.com',
    });

    // A second subject for the same person remains one logical registry
    // candidate and does not become an ambiguity.
    const secondSubject = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      openId: 'open-1',
      displayName: '其他名称',
    });
    // A configured (not yet operator-verified) subject remains read-only and
    // must not receive a person_id or downstream @ attribution.
    assert.equal(secondSubject?.personId, null);
    assert.equal(secondSubject?.identityStatus, 'configured');
  });
});

test('startup accepts a configured shared Git identity but write admission stays gated', async () => {
  await withRegistry(() => {
    process.env.CLOUDCLI_SHARED_GIT_IDENTITY_ID = 'vcs-shared';
    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.vcs_identities[0].status = 'configured';
    fs.writeFileSync(registryPath, JSON.stringify(registry));

    assert.doesNotThrow(() => identityRegistryService.assertConfiguration());
    assert.deepEqual(identityRegistryService.getSharedGitIdentity({ requireVerified: false }), {
      id: 'vcs-shared',
      name: 'shared-bot',
      email: 'shared@example.com',
    });
    assert.equal(identityRegistryService.getSharedGitIdentity(), null);
  });
});

test('identity registries reject writable, symlinked, and non-regular files', async () => {
  await withRegistry(async () => {
    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    await chmod(registryPath, 0o664);
    assert.throws(
      () => identityRegistryService.resolveDingTalkIdentity({
        providerKey: 'comic', unionId: 'union-1', displayName: '张三',
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'IDENTITY_REGISTRY_PERMISSIONS',
    );

    const target = path.join(path.dirname(registryPath), 'registry-target.json');
    await writeFile(target, await readFile(registryPath), { mode: 0o644 });
    const link = path.join(path.dirname(registryPath), 'registry-link.json');
    await symlink(target, link);
    process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = link;
    assert.throws(
      () => identityRegistryService.resolveDingTalkIdentity({
        providerKey: 'comic', unionId: 'union-1', displayName: '张三',
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'IDENTITY_REGISTRY_PERMISSIONS',
    );

    process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = path.dirname(registryPath);
    assert.throws(
      () => identityRegistryService.resolveDingTalkIdentity({
        providerKey: 'comic', unionId: 'union-1', displayName: '张三',
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'IDENTITY_REGISTRY_PERMISSIONS',
    );
  });
});

test('unknown and ambiguous subjects remain pending instead of guessing by name', async () => {
  await withRegistry(() => {
    const unknown = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'not-registered',
      displayName: '张三',
    });
    assert.equal(unknown?.personId, null);
    assert.equal(unknown?.identityStatus, 'pending');
  });
});

test('bridge sender resolution requires the explicit namespace and subject type', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-bridge-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [],
      dingtalk_senders: [{
        provider_key: 'comic', namespace: 'bridge-app', subject_type: 'open_dingtalk_id',
        subject: 'sender-1', person_id: 'alice', binding_ref: 'dingtalk-sender/alice/comic', status: 'verified',
      }],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;
    const resolved = identityRegistryService.resolveDingTalkBridgeIdentity({
      providerKey: 'comic', namespace: 'bridge-app', senderScope: 'open_dingtalk_id', senderId: 'sender-1',
    });
    assert.equal(resolved.personId, 'alice');
    assert.equal(resolved.identityStatus, 'verified');
    const wrongNamespace = identityRegistryService.resolveDingTalkBridgeIdentity({
      providerKey: 'comic', namespace: 'other-app', senderScope: 'open_dingtalk_id', senderId: 'sender-1',
    });
    assert.equal(wrongNamespace.personId, null);
    assert.equal(wrongNamespace.identityStatus, 'pending');
    const wrongType = identityRegistryService.resolveDingTalkBridgeIdentity({
      providerKey: 'comic', namespace: 'bridge-app', senderScope: 'user_id', senderId: 'sender-1',
      displayName: '张三',
    });
    assert.equal(wrongType.personId, null, 'same display name cannot bypass the typed namespace');
    const data = JSON.parse(await readFile(runtimeMap, 'utf8'));
    for (const status of ['pending', 'configured', 'active']) {
      data.dingtalk_senders[0].status = status;
      await writeFile(runtimeMap, JSON.stringify(data));
      const unverified = identityRegistryService.resolveDingTalkBridgeIdentity({
        providerKey: 'comic', namespace: 'bridge-app', senderScope: 'open_dingtalk_id', senderId: 'sender-1',
      });
      assert.equal(unverified.personId, null, status);
      assert.notEqual(unverified.identityStatus, 'verified', status);
    }
    data.dingtalk_senders.push({ ...data.dingtalk_senders[0], person_id: 'bob' });
    await writeFile(runtimeMap, JSON.stringify(data));
    assert.throws(() => identityRegistryService.resolveDingTalkBridgeIdentity({
      providerKey: 'comic', namespace: 'bridge-app', senderScope: 'open_dingtalk_id', senderId: 'sender-1',
    }), (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'IDENTITY_RUNTIME_MAP_AMBIGUOUS');
    await rm(directory, { recursive: true, force: true });
  });
});

test('binding references resolve through a protected runtime subject map', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-runtime-map-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [{
        provider_key: 'comic',
        binding_ref: 'dingtalk-subject/alice/comic',
        subject: 'runtime-union-1',
        subject_scope: 'global',
        status: 'active',
      }],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;
    // Replace the fixture's raw-only subject with a non-sensitive binding ref
    // so resolution must come from the protected file.
    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'comic',
      binding_ref: 'dingtalk-subject/alice/comic',
      status: 'verified',
    }];
    await writeFile(registryPath, JSON.stringify(registry));
    const resolved = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'runtime-union-1',
      displayName: '伪造名称',
    });
    assert.equal(resolved?.personId, 'alice');
    assert.equal(resolved?.externalSubject, 'runtime-union-1');
    await rm(directory, { recursive: true, force: true });
  });
});

test('first authenticated login automatically pins one unique roster name to its stable subject', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-auto-enrollment-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;

    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.people[0].verification.status = 'configured';
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'comic',
      binding_ref: 'dingtalk-subject/alice/comic',
      status: 'runtime_configured',
    }];
    await writeFile(registryPath, JSON.stringify(registry));

    const beforeEnrollment = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'new-stable-subject',
      displayName: '张三',
    });
    assert.equal(beforeEnrollment?.identityStatus, 'pending');

    const enrolled = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'new-stable-subject',
      displayName: '张三',
    }, { allowAutomaticEnrollment: true });
    assert.equal(enrolled?.personId, 'alice');
    assert.equal(enrolled?.identityStatus, 'verified');

    const savedMap = JSON.parse(await readFile(runtimeMap, 'utf8'));
    assert.deepEqual(savedMap.dingtalk_subjects, [{
      provider_key: 'comic',
      binding_ref: 'dingtalk-subject/alice/comic',
      subject: 'new-stable-subject',
      subject_scope: 'global',
      status: 'active',
    }]);
    assert.equal((await stat(runtimeMap)).mode & 0o777, 0o600);

    const renamedLogin = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'new-stable-subject',
      displayName: '之后改过的名字',
    });
    assert.equal(renamedLogin?.personId, 'alice');
    assert.equal(renamedLogin?.identityStatus, 'verified');
    await rm(directory, { recursive: true, force: true });
  });
});

test('automatic enrollment does not guess when one provider has duplicate roster names', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-auto-ambiguous-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;

    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'comic',
      binding_ref: 'dingtalk-subject/alice/comic',
      status: 'runtime_configured',
    }];
    registry.people[1].display_name = '张三';
    registry.people[1].dingtalk.subjects = [{
      provider_key: 'comic',
      binding_ref: 'dingtalk-subject/bob/comic',
      status: 'runtime_configured',
    }];
    await writeFile(registryPath, JSON.stringify(registry));

    const result = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'ambiguous-subject',
      displayName: '张三',
    }, { allowAutomaticEnrollment: true });
    assert.equal(result?.personId, null);
    assert.equal(result?.identityStatus, 'ambiguous');
    assert.deepEqual(JSON.parse(await readFile(runtimeMap, 'utf8')).dingtalk_subjects, []);
    await rm(directory, { recursive: true, force: true });
  });
});

test('automatic enrollment binds across linked providers on a unique roster name', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-auto-or-provider-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;

    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    // Alice is only declared for the haohan organization; the login arrives
    // through the linked dongying provider, which the registry does not model.
    registry.people[0].verification.status = 'configured';
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'haohan',
      binding_ref: 'dingtalk-subject/alice/haohan',
      status: 'runtime_configured',
    }];
    await writeFile(registryPath, JSON.stringify(registry));

    const enrolled = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'dongying',
      unionId: 'dongying-stable-subject',
      displayName: '张三',
    }, { allowAutomaticEnrollment: true });
    assert.equal(enrolled?.personId, 'alice');
    assert.equal(enrolled?.identityStatus, 'verified');

    const savedMap = JSON.parse(await readFile(runtimeMap, 'utf8'));
    assert.deepEqual(savedMap.dingtalk_subjects, [{
      provider_key: 'dongying',
      binding_ref: 'dingtalk-subject/alice/dongying',
      subject: 'dongying-stable-subject',
      subject_scope: 'global',
      status: 'active',
    }]);
    assert.equal((await stat(runtimeMap)).mode & 0o777, 0o600);

    // The synthesized binding keeps resolving on later logins even though the
    // registry still has no dongying subject entry for alice.
    const relogin = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'dongying',
      unionId: 'dongying-stable-subject',
      displayName: '张三',
    });
    assert.equal(relogin?.personId, 'alice');
    assert.equal(relogin?.identityStatus, 'verified');
    await rm(directory, { recursive: true, force: true });
  });
});

test('automatic enrollment prefers registered DingTalk identifiers over names across providers', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-auto-id-match-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;

    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.people[0].verification.status = 'configured';
    registry.people[0].dingtalk.open_dingtalk_id = 'registered-open-id';
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'haohan',
      binding_ref: 'dingtalk-subject/alice/haohan',
      status: 'runtime_configured',
    }];
    await writeFile(registryPath, JSON.stringify(registry));

    const enrolled = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'dongying',
      openId: 'registered-open-id',
      displayName: '和登记名字完全无关',
    }, { allowAutomaticEnrollment: true });
    assert.equal(enrolled?.personId, 'alice');
    assert.equal(enrolled?.identityStatus, 'verified');
    assert.deepEqual(JSON.parse(await readFile(runtimeMap, 'utf8')).dingtalk_subjects, [{
      provider_key: 'dongying',
      binding_ref: 'dingtalk-subject/alice/dongying',
      subject: 'registered-open-id',
      subject_scope: 'provider',
      status: 'active',
    }]);
    await rm(directory, { recursive: true, force: true });
  });
});

test('automatic enrollment binds through a registered display alias across providers', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-auto-alias-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;

    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.people[0].display_name = '胡孙昂';
    registry.people[0].display_aliases = ['Dean'];
    registry.people[0].verification.status = 'configured';
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'haohan',
      binding_ref: 'dingtalk-subject/alice/haohan',
      status: 'runtime_configured',
    }];
    await writeFile(registryPath, JSON.stringify(registry));

    const enrolled = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'dongying',
      unionId: 'dean-dongying-subject',
      displayName: 'Dean',
    }, { allowAutomaticEnrollment: true });
    assert.equal(enrolled?.personId, 'alice');
    assert.equal(enrolled?.displayName, '胡孙昂');
    assert.equal(enrolled?.identityStatus, 'verified');
    await rm(directory, { recursive: true, force: true });
  });
});

test('automatic enrollment stays ambiguous when duplicate roster names span providers', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-auto-or-ambiguous-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;

    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    // Both active people share the login display name and neither declares a
    // dongying subject, so the provider-agnostic fallback must not guess.
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'haohan',
      binding_ref: 'dingtalk-subject/alice/haohan',
      status: 'runtime_configured',
    }];
    registry.people[1].display_name = '张三';
    registry.people[1].dingtalk.subjects = [{
      provider_key: 'haohan',
      binding_ref: 'dingtalk-subject/bob/haohan',
      status: 'runtime_configured',
    }];
    await writeFile(registryPath, JSON.stringify(registry));

    const result = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'dongying',
      unionId: 'dongying-ambiguous-subject',
      displayName: '张三',
    }, { allowAutomaticEnrollment: true });
    assert.equal(result?.personId, null);
    assert.equal(result?.identityStatus, 'ambiguous');
    assert.deepEqual(JSON.parse(await readFile(runtimeMap, 'utf8')).dingtalk_subjects, []);
    await rm(directory, { recursive: true, force: true });
  });
});

test('runtime subject maps reject broad permissions and symlink indirection', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-runtime-map-permissions-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    const mapContents = JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [{
        provider_key: 'comic',
        binding_ref: 'dingtalk-subject/alice/comic',
        subject: 'runtime-union-1',
        subject_scope: 'global',
        status: 'active',
      }],
    });
    await writeFile(runtimeMap, mapContents, { mode: 0o600 });
    await chmod(runtimeMap, 0o640);
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;
    assert.throws(
      () => identityRegistryService.resolveDingTalkIdentity({
        providerKey: 'comic', unionId: 'runtime-union-1', displayName: '张三',
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'IDENTITY_RUNTIME_MAP_PERMISSIONS',
    );

    const target = path.join(directory, 'target.json');
    await writeFile(target, mapContents, { mode: 0o600 });
    const link = path.join(directory, 'linked-runtime-map.json');
    await symlink(target, link);
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = link;
    assert.throws(
      () => identityRegistryService.resolveDingTalkIdentity({
        providerKey: 'comic', unionId: 'runtime-union-1', displayName: '张三',
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'IDENTITY_RUNTIME_MAP_PERMISSIONS',
    );
    await rm(directory, { recursive: true, force: true });
  });
});

test('runtime subject maps reject a missing or malformed subjects array', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-runtime-map-shape-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({ schema_version: 1 }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;
    assert.throws(
      () => identityRegistryService.resolveDingTalkIdentity({
        providerKey: 'comic', unionId: 'runtime-union-1', displayName: '张三',
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'IDENTITY_RUNTIME_MAP_INVALID',
    );

    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [null],
    }), { mode: 0o600 });
    assert.throws(
      () => identityRegistryService.resolveDingTalkIdentity({
        providerKey: 'comic', unionId: 'runtime-union-1', displayName: '张三',
      }),
      (error: unknown) => error instanceof Error && 'code' in error
        && error.code === 'IDENTITY_RUNTIME_MAP_INVALID',
    );
    await rm(directory, { recursive: true, force: true });
  });
});

test('configured runtime bindings remain non-verified until operator confirmation', async () => {
  await withRegistry(async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-identity-runtime-map-configured-'));
    const runtimeMap = path.join(directory, 'identity-runtime-map.json');
    await writeFile(runtimeMap, JSON.stringify({
      schema_version: 1,
      dingtalk_subjects: [{
        provider_key: 'comic',
        binding_ref: 'dingtalk-subject/alice/comic',
        subject: 'runtime-union-1',
        subject_scope: 'global',
        status: 'configured',
      }],
    }), { mode: 0o600 });
    process.env.CLOUDCLI_IDENTITY_RUNTIME_MAP_PATH = runtimeMap;
    const registryPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH as string;
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.people[0].dingtalk.subjects = [{
      provider_key: 'comic',
      binding_ref: 'dingtalk-subject/alice/comic',
      status: 'verified',
    }];
    await writeFile(registryPath, JSON.stringify(registry));

    const resolved = identityRegistryService.resolveDingTalkIdentity({
      providerKey: 'comic',
      unionId: 'runtime-union-1',
      displayName: '张三',
    });
    assert.equal(resolved?.personId, null);
    assert.equal(resolved?.identityStatus, 'configured');
    await rm(directory, { recursive: true, force: true });
  });
});

test('an execution boundary can require a missing registry without changing local fallback behavior', () => {
  const previousPath = process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
  const previousRequired = process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
  delete process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
  delete process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
  try {
    assert.equal(identityRegistryService.isConfigured({ required: false }), false);
    assert.throws(
      () => identityRegistryService.assertConfiguration({ required: true }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'IDENTITY_REGISTRY_NOT_CONFIGURED',
    );
    // An explicit local override remains non-required even if the legacy
    // process switch is present. Managed composition passes `required: true`
    // explicitly (and pins that choice at server startup).
    process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = '1';
    assert.equal(identityRegistryService.isConfigured({ required: false }), false);
  } finally {
    if (previousPath === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_PATH = previousPath;
    if (previousRequired === undefined) delete process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED;
    else process.env.CLOUDCLI_IDENTITY_REGISTRY_REQUIRED = previousRequired;
  }
});
