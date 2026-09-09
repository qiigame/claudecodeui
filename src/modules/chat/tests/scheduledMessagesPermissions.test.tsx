import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

const listScheduledMessages = vi.fn();
const createScheduledMessage = vi.fn();
const cancelScheduledMessage = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    scheduledMessages: {
      list: (sessionId: string, options?: { signal?: AbortSignal }) => listScheduledMessages(sessionId, options),
      create: (body: unknown) => createScheduledMessage(body),
      cancel: (id: string) => cancelScheduledMessage(id),
    },
  },
}));

beforeEach(() => {
  listScheduledMessages.mockReset();
  createScheduledMessage.mockReset();
  cancelScheduledMessage.mockReset();
  listScheduledMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ id: 'scheduled-1', status: 'pending' }] }),
  });
  createScheduledMessage.mockResolvedValue({ ok: true, json: async () => ({}) });
  cancelScheduledMessage.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  vi.resetModules();
});

test('a deployment without agent.use never loads scheduled messages', async () => {
  const { useScheduledMessages } = await import(
    '@/modules/chat/composer/useScheduledMessages'
  );
  const view = renderHook(
    ({ canSchedule }) => useScheduledMessages('session-1', { canSchedule }),
    { initialProps: { canSchedule: false } },
  );

  await act(async () => Promise.resolve());
  assert.equal(listScheduledMessages.mock.calls.length, 0);
  assert.deepEqual(view.result.current.scheduledMessages, []);

  view.rerender({ canSchedule: true });
  await waitFor(() => {
    assert.equal(listScheduledMessages.mock.calls.length, 1);
  });
  assert.equal(view.result.current.scheduledMessages.length, 1);

  view.rerender({ canSchedule: false });
  await waitFor(() => {
    assert.deepEqual(view.result.current.scheduledMessages, []);
  });
  assert.equal(listScheduledMessages.mock.calls.length, 1);
});

test('a late list response from the previous session cannot repopulate the new session', async () => {
  const requests: Array<{
    sessionId: string;
    signal?: AbortSignal;
    resolve: (response: unknown) => void;
  }> = [];
  listScheduledMessages.mockImplementation((sessionId: string, options?: { signal?: AbortSignal }) => (
    new Promise((resolve) => {
      requests.push({ sessionId, signal: options?.signal, resolve });
    })
  ));

  const { useScheduledMessages } = await import(
    '@/modules/chat/composer/useScheduledMessages'
  );
  const view = renderHook(
    ({ sessionId }: { sessionId: string }) => useScheduledMessages(sessionId, { canSchedule: true }),
    { initialProps: { sessionId: 'session-a' } },
  );

  await waitFor(() => assert.equal(requests.length, 1));
  view.rerender({ sessionId: 'session-b' });
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[0].sessionId, 'session-a');
  assert.equal(requests[1].sessionId, 'session-b');
  assert.equal(requests[0].signal?.aborted, true);
  assert.deepEqual(view.result.current.scheduledMessages, []);

  await act(async () => {
    requests[0].resolve({ ok: true, json: async () => ({ data: [{ id: 'old' }] }) });
    await Promise.resolve();
  });
  assert.deepEqual(view.result.current.scheduledMessages, []);

  await act(async () => {
    requests[1].resolve({ ok: true, json: async () => ({ data: [{ id: 'new' }] }) });
    await Promise.resolve();
  });
  await waitFor(() => assert.deepEqual(
    view.result.current.scheduledMessages.map((message) => message.id),
    ['new'],
  ));
});

test('disabling scheduling aborts and invalidates an in-flight list response', async () => {
  let resolveList: ((response: unknown) => void) | null = null;
  listScheduledMessages.mockImplementationOnce((_sessionId: string, options?: { signal?: AbortSignal }) => (
    new Promise((resolve) => {
      resolveList = resolve;
      assert.ok(options?.signal);
    })
  ));

  const { useScheduledMessages } = await import(
    '@/modules/chat/composer/useScheduledMessages'
  );
  const view = renderHook(
    ({ canSchedule }: { canSchedule: boolean }) => useScheduledMessages('session-a', { canSchedule }),
    { initialProps: { canSchedule: true } },
  );

  await waitFor(() => assert.equal(listScheduledMessages.mock.calls.length, 1));
  const signal = listScheduledMessages.mock.calls[0][1]?.signal as AbortSignal;
  view.rerender({ canSchedule: false });
  await waitFor(() => assert.deepEqual(view.result.current.scheduledMessages, []));
  assert.equal(signal.aborted, true);

  await act(async () => {
    resolveList?.({ ok: true, json: async () => ({ data: [{ id: 'late' }] }) });
    await Promise.resolve();
  });
  assert.deepEqual(view.result.current.scheduledMessages, []);
});

test('a schedule that finishes after navigation does not refresh or report success to the new session', async () => {
  let resolveCreate: ((response: unknown) => void) | null = null;
  createScheduledMessage.mockImplementationOnce(() => new Promise((resolve) => {
    resolveCreate = resolve;
  }));

  const { useScheduledMessages } = await import(
    '@/modules/chat/composer/useScheduledMessages'
  );
  const view = renderHook(
    ({ sessionId }: { sessionId: string }) => useScheduledMessages(sessionId, { canSchedule: true }),
    { initialProps: { sessionId: 'session-a' } },
  );
  await waitFor(() => assert.equal(listScheduledMessages.mock.calls.length, 1));

  let scheduled: Promise<boolean> | null = null;
  act(() => {
    scheduled = view.result.current.schedule({
      content: 'later',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
    });
  });
  view.rerender({ sessionId: 'session-b' });

  await act(async () => {
    resolveCreate?.({ ok: true, json: async () => ({}) });
    await Promise.resolve();
  });
  assert.equal(await scheduled, false);
  assert.equal(
    listScheduledMessages.mock.calls.filter(([sessionId]) => sessionId === 'session-a').length,
    1,
  );
});
