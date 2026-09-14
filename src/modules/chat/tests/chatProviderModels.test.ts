import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProjectSession } from '@/shared/types';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

const providerModelsRequest = vi.fn((_provider: string) => okJson({
  success: true,
  data: null,
}));
const providerCapabilitiesRequest = vi.fn(() => okJson({ success: true, data: null }));

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: string) => providerModelsRequest(provider),
      capabilities: () => providerCapabilitiesRequest(),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async (
  readOnly = false,
  selectedSession: Pick<ProjectSession, 'id' | 'provider' | '__provider'> | null = null,
  options: {
    defaultPermissionMode?: 'default' | 'bypassPermissions';
    newSessionTrigger?: number;
  } = {},
) => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook((props) =>
    useChatProviderState({ ...props, selectedProject: null }),
    { initialProps: { selectedSession, readOnly, ...options } },
  );
};

beforeEach(() => {
  localStorage.clear();
  providerModelsRequest.mockClear();
  providerCapabilitiesRequest.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('a configured developer default applies to each new chat without overwriting an existing session', async () => {
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('permissionMode-last-codex', 'default');
  localStorage.setItem('permissionMode-existing-session', 'acceptEdits');
  const options = { defaultPermissionMode: 'bypassPermissions' as const, newSessionTrigger: 1 };
  const { result, rerender } = await renderProviderState(false, null, options);

  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));
  act(() => result.current.selectPermissionMode('default'));
  assert.equal(result.current.permissionMode, 'default');

  // Repeated new-chat intent matters even when the composer has no session ID.
  rerender({ selectedSession: null, readOnly: false, ...options, newSessionTrigger: 2 });
  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));

  rerender({
    selectedSession: { id: 'existing-session', __provider: 'codex' },
    readOnly: false,
    ...options,
  });
  await waitFor(() => assert.equal(result.current.permissionMode, 'acceptEdits'));
});

test('the first send pins its current permission mode before the session ID handoff', async () => {
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('permissionMode-last-codex', 'default');
  const options = { defaultPermissionMode: 'bypassPermissions' as const };
  const { result, rerender } = await renderProviderState(false, null, options);

  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));
  act(() => result.current.pinPermissionModeForSession('created-session'));
  rerender({
    selectedSession: { id: 'created-session', __provider: 'codex' },
    readOnly: false,
    ...options,
  });

  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));
  assert.equal(localStorage.getItem('permissionMode-created-session'), 'bypassPermissions');
  assert.equal(localStorage.getItem('permissionMode-last-codex'), 'default');
});

test('a late provider capability response preserves the mode explicitly chosen for an unsent draft', async () => {
  writeUserPreference('selectedProvider', 'codex');
  let resolveCapabilities!: (response: Awaited<ReturnType<typeof okJson>>) => void;
  providerCapabilitiesRequest.mockReturnValue(new Promise((resolve) => { resolveCapabilities = resolve; }));
  const { result } = await renderProviderState(false, null, { defaultPermissionMode: 'bypassPermissions' });

  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));
  act(() => result.current.selectPermissionMode('acceptEdits'));
  await act(async () => resolveCapabilities(await okJson({
    success: true,
    data: {
      providers: [{
        provider: 'codex',
        permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
        defaultPermissionMode: 'default',
      }],
    },
  })));

  assert.equal(result.current.permissionMode, 'acceptEdits');
  act(() => result.current.pinPermissionModeForSession('chosen-session'));
  assert.equal(localStorage.getItem('permissionMode-chosen-session'), 'acceptEdits');
});

test('the deployment default cannot select a mode excluded by provider capabilities', async () => {
  writeUserPreference('selectedProvider', 'codex');
  providerCapabilitiesRequest.mockImplementation(() => okJson({
    success: true,
    data: {
      providers: [{
        provider: 'codex',
        permissionModes: ['default'],
        defaultPermissionMode: 'default',
      }],
    },
  }));
  const { result } = await renderProviderState(false, null, { defaultPermissionMode: 'bypassPermissions' });

  await waitFor(() => assert.deepEqual(result.current.availablePermissionModes, ['default']));
  assert.equal(result.current.permissionMode, 'default');
});

test('a temporary policy refresh restricts the draft without discarding its explicit choice', async () => {
  writeUserPreference('selectedProvider', 'codex');
  const { result, rerender } = await renderProviderState(false, null, { defaultPermissionMode: 'bypassPermissions' });
  await waitFor(() => assert.equal(result.current.permissionMode, 'bypassPermissions'));
  act(() => result.current.selectPermissionMode('acceptEdits'));

  // Policy reloads fail closed while the server response is in flight.
  rerender({ selectedSession: null, readOnly: true, defaultPermissionMode: 'default' });
  await waitFor(() => assert.equal(result.current.permissionMode, 'default'));
  assert.equal(result.current.availablePermissionModes.length, 0);

  rerender({ selectedSession: null, readOnly: false, defaultPermissionMode: 'bypassPermissions' });
  await waitFor(() => assert.equal(result.current.permissionMode, 'acceptEdits'));
});

test('read-only policy overrides the configured default, stored preference and attempted selection', async () => {
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('permissionMode-last-codex', 'bypassPermissions');
  const { result } = await renderProviderState(true, null, { defaultPermissionMode: 'bypassPermissions' });

  await waitFor(() => assert.equal(result.current.permissionMode, 'default'));
  act(() => result.current.selectPermissionMode('bypassPermissions'));
  act(() => result.current.pinPermissionModeForSession('readonly-session'));

  assert.equal(result.current.permissionMode, 'default');
  assert.equal(result.current.availablePermissionModes.length, 0);
  assert.equal(result.current.resolvePermissionModeForProvider('codex', 'bypassPermissions'), 'default');
  assert.equal(localStorage.getItem('permissionMode-readonly-session'), 'default');
});

test('an unconfigured deployment retains the provider preference used by the fork', async () => {
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('permissionMode-last-codex', 'acceptEdits');
  const { result } = await renderProviderState();

  await waitFor(() => assert.equal(result.current.permissionMode, 'acceptEdits'));
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});

test('a read-only deployment falls back from an unsafe persisted provider for new chats', async () => {
  writeUserPreference('selectedProvider', 'cursor');

  const { result } = await renderProviderState(true);

  await waitFor(() => {
    assert.ok(['codex', 'claude'].includes(result.current.provider));
  });
  assert.equal(result.current.availablePermissionModes.length, 0);
});

test('a read-only deployment loads catalogs only for its proven runtime providers', async () => {
  await renderProviderState(true);

  await waitFor(() => {
    assert.equal(providerModelsRequest.mock.calls.length, 2);
  });
  assert.deepEqual(
    providerModelsRequest.mock.calls.map(([provider]) => provider).sort(),
    ['claude', 'codex'],
  );
});

test('a writable deployment retains all provider catalogs', async () => {
  await renderProviderState(false);

  await waitFor(() => {
    assert.equal(providerModelsRequest.mock.calls.length, 4);
  });
  assert.deepEqual(
    providerModelsRequest.mock.calls.map(([provider]) => provider).sort(),
    ['claude', 'codex', 'cursor', 'opencode'],
  );
});

test('session provider fallback also honors the public provider field in read-only mode', async () => {
  writeUserPreference('selectedProvider', 'codex');

  const { result } = await renderProviderState(true, {
    id: 'legacy-opencode-session',
    provider: 'opencode',
  });

  await waitFor(() => {
    assert.equal(result.current.provider, 'opencode');
  });
  // The transcript remains readable, but the provider hook must not silently
  // replace the server-owned session provider with the browser default.
  assert.equal(result.current.availablePermissionModes.length, 0);
});
