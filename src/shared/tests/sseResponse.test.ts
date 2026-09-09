import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { api, consumeSseResponse } from '@/shared/api';

const encodeChunks = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('consumeSseResponse parses records split across UTF-8 chunks', async () => {
  const events: Array<{ event: string; data: string }> = [];
  const response = new Response(encodeChunks([
    ': keep-alive\r\n\r\n',
    'event: result\r\ndata: {"message":"你好',
    '"}\r\ndata: second-line\r\n\r\n',
    'data: default-event\n\n',
  ]), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

  await consumeSseResponse(response, (event) => events.push(event));

  assert.deepEqual(events, [
    { event: 'result', data: '{"message":"你好"}\nsecond-line' },
    { event: 'message', data: 'default-event' },
  ]);
});

test('searchConversations authenticates with a header and never serializes the JWT', async () => {
  const token = 'header.payload.signature';
  localStorage.setItem('auth-token', token);
  const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
    new Response('', { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await api.searchConversations('private notes', 10);

  const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
  assert.equal(url, '/api/providers/search/sessions?q=private+notes&limit=10');
  assert.equal(url.includes('token='), false);
  assert.equal((options.headers as Record<string, string>).Authorization, `Bearer ${token}`);
});

test('consumeSseResponse rejects non-success responses before reading a body', async () => {
  await assert.rejects(
    consumeSseResponse(new Response('denied', { status: 403 }), () => undefined),
    /Request failed \(403\)/,
  );
});
