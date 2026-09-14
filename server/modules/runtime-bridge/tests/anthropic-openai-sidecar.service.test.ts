import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import test from 'node:test';

import { createAnthropicOpenAiBridgeServer } from '@/modules/runtime-bridge/index.js';

type JsonRecord = Record<string, unknown>;

async function listen(server: Server): Promise<string> {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  server.closeAllConnections();
  await closed;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord;
}

function writeOpenAiSse(response: http.ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function parseAnthropicSse(payload: string): Array<{ event: string; data: JsonRecord }> {
  return payload
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '';
      const encoded = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      return { event, data: JSON.parse(encoded) as JsonRecord };
    });
}

test('exposes health and token counting without calling the upstream', async () => {
  const bridge = createAnthropicOpenAiBridgeServer({
    upstreamBaseUrl: 'http://127.0.0.1:1/v1',
  });
  const bridgeUrl = await listen(bridge);

  try {
    const healthResponse = await fetch(`${bridgeUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      status: 'ok',
      service: 'comic-anthropic-openai-bridge',
    });

    const missingTokenResponse = await fetch(`${bridgeUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ignored', messages: [] }),
    });
    assert.equal(missingTokenResponse.status, 401);
    assert.deepEqual(await missingTokenResponse.json(), {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'An Anthropic API key or bearer token is required.',
      },
    });

    const countResponse = await fetch(`${bridgeUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'count-test-key',
      },
      body: JSON.stringify({
        model: 'kimi-k2.6',
        system: 'short system prompt',
        messages: [{ role: 'user', content: 'count these words' }],
      }),
    });
    assert.equal(countResponse.status, 200);
    const countBody = await countResponse.json() as { input_tokens: number };
    assert.ok(countBody.input_tokens > 1);
  } finally {
    await close(bridge);
  }
});

test('translates non-streaming Anthropic messages, tools, and usage without leaking credentials', async () => {
  let upstreamAuthorization: string | undefined;
  let upstreamBody: JsonRecord | undefined;
  const upstream = http.createServer((request, response) => {
    void (async () => {
      upstreamAuthorization = request.headers.authorization;
      upstreamBody = await readJsonBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            reasoning_content: 'Checked the request.',
            content: 'I will use the tool.',
            tool_calls: [{
              id: 'call-new-tool',
              type: 'function',
              function: { name: 'echo', arguments: '{"value":"ready"}' },
            }],
          },
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }));
    })();
  });
  const upstreamUrl = await listen(upstream);
  let nextId = 0;
  const bridge = createAnthropicOpenAiBridgeServer({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    upstreamModel: 'kimi-k2.6',
    reasoningEffort: 'low',
  }, {
    idFactory: () => `test-${++nextId}`,
  });
  const bridgeUrl = await listen(bridge);

  try {
    const bridgeResponse = await fetch(`${bridgeUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sidecar-test-key',
      },
      body: JSON.stringify({
        model: 'claude-client-model',
        max_tokens: 1024,
        system: [{ type: 'text', text: 'You are concise.' }],
        messages: [{
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Previous thought.', signature: 'not-forwarded' },
            { type: 'text', text: 'Earlier answer.' },
            { type: 'tool_use', id: 'call-prior-tool', name: 'echo', input: { value: 'before' } },
          ],
        }, {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call-prior-tool',
            content: [{ type: 'text', text: 'previous result' }],
          }],
        }, {
          role: 'user',
          content: [{ type: 'text', text: 'Continue.' }],
        }],
        tools: [{
          name: 'echo',
          description: 'Echo a value.',
          input_schema: {
            type: 'object',
            properties: {
              payload: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                $defs: {
                  FilterRelation: {
                    type: 'string',
                    enum: ['and', 'or'],
                  },
                },
                type: 'object',
                properties: {
                  relation: {
                    $ref: '#/$defs/FilterRelation',
                    description: 'How filters are combined.',
                  },
                  count: {
                    type: 'integer',
                    format: 'int32',
                    additionalProperties: false,
                  },
                  anything: true,
                  values: {
                    type: 'array',
                    items: true,
                  },
                },
                required: ['relation'],
              },
            },
            required: ['payload'],
          },
        }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      }),
    });

    assert.equal(bridgeResponse.status, 200);
    const responseText = await bridgeResponse.text();
    const responseBody = JSON.parse(responseText) as JsonRecord;
    assert.equal(upstreamAuthorization, 'Bearer sidecar-test-key');
    assert.doesNotMatch(responseText, /sidecar-test-key|not-forwarded/);
    assert.equal(upstreamBody?.model, 'kimi-k2.6');
    assert.equal(upstreamBody?.reasoning_effort, 'low');
    assert.equal(upstreamBody?.stream, false);
    assert.equal(upstreamBody?.parallel_tool_calls, false);
    assert.deepEqual(upstreamBody?.messages, [
      { role: 'system', content: 'You are concise.' },
      {
        role: 'assistant',
        content: 'Earlier answer.',
        reasoning_content: 'Previous thought.',
        tool_calls: [{
          id: 'call-prior-tool',
          type: 'function',
          function: { name: 'echo', arguments: '{"value":"before"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-prior-tool', content: 'previous result' },
      { role: 'user', content: 'Continue.' },
    ]);
    assert.deepEqual(upstreamBody?.tools, [{
      type: 'function',
      function: {
        name: 'echo',
        description: 'Echo a value.',
        parameters: {
          type: 'object',
          properties: {
            payload: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              $defs: {
                FilterRelation: { type: 'string', enum: ['and', 'or'] },
              },
              type: 'object',
              properties: {
                relation: {
                  $ref: '#/properties/payload/$defs/FilterRelation',
                  description: 'How filters are combined.',
                },
                count: {
                  type: 'integer',
                  format: 'int32',
                  additionalProperties: false,
                },
                anything: true,
                values: {
                  type: 'array',
                  items: true,
                },
              },
              required: ['relation'],
            },
          },
          required: ['payload'],
        },
      },
    }]);
    assert.deepEqual(responseBody, {
      id: 'msg_bridge_test-1',
      type: 'message',
      role: 'assistant',
      model: 'claude-client-model',
      content: [{
        type: 'thinking',
        thinking: 'Checked the request.',
        signature: responseBody.content instanceof Array
          ? (responseBody.content[0] as JsonRecord).signature
          : undefined,
      }, {
        type: 'text',
        text: 'I will use the tool.',
      }, {
        type: 'tool_use',
        id: 'call-new-tool',
        name: 'echo',
        input: { value: 'ready' },
      }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 3,
      },
    });
    const responseContent = responseBody.content as JsonRecord[];
    assert.match(String(responseContent[0]?.signature), /^bridge_[A-Za-z0-9_-]+$/);
  } finally {
    await close(bridge);
    await close(upstream);
  }
});

test('preserves valid root references, recursive constraints, booleans and literal defaults', async () => {
  let upstreamBody: JsonRecord | undefined;
  const upstream = http.createServer((request, response) => {
    void (async () => {
      upstreamBody = await readJsonBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    })();
  });
  const upstreamUrl = await listen(upstream);
  const bridge = createAnthropicOpenAiBridgeServer({ upstreamBaseUrl: `${upstreamUrl}/v1` });
  const bridgeUrl = await listen(bridge);
  const literal = { format: 'literal', $defs: { type: 'keep' }, $ref: '#/literal' };

  try {
    const response = await fetch(`${bridgeUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'schema-test-token' },
      body: JSON.stringify({
        model: 'schema-test-model',
        messages: [{ role: 'user', content: 'Inspect schemas.' }],
        tools: [{
          name: 'inspect',
          input_schema: {
            type: 'object',
            definitions: {
              'with/slash': { type: 'string', enum: ['ready'] },
              Node: { type: 'object', properties: { next: { $ref: '#/definitions/Node' } } },
            },
            properties: {
              label: { $ref: '#/definitions/with~1slash', description: 'Label.' },
              tree: { $ref: '#/definitions/Node' },
              payload: { type: 'object', default: literal, enum: [literal] },
              excluded: false,
              allowed: { not: false },
              condition: { if: false, then: false, else: true },
            },
            additionalProperties: false,
          },
        }],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody?.tools, [{
      type: 'function',
      function: {
        name: 'inspect',
        parameters: {
          type: 'object',
          definitions: {
            'with/slash': { type: 'string', enum: ['ready'] },
            Node: { type: 'object', properties: { next: { $ref: '#/definitions/Node' } } },
          },
          properties: {
            label: { $ref: '#/definitions/with~1slash', description: 'Label.' },
            tree: { $ref: '#/definitions/Node' },
            payload: { type: 'object', default: literal, enum: [literal] },
            excluded: false,
            allowed: { not: false },
            condition: { if: false, then: false, else: true },
          },
          additionalProperties: false,
        },
      },
    }]);
  } finally {
    await close(bridge);
    await close(upstream);
  }
});

test('repairs only unresolved scoped definition pointers and preserves other reference boundaries', async () => {
  const cases: Array<{ name: string; schema: JsonRecord; expected?: JsonRecord }> = [
    {
      name: 'escaped nested definition',
      schema: {
        type: 'object',
        properties: {
          'with/slash': {
            definitions: { 'value/name': { type: 'string' } },
            $ref: '#/definitions/value~1name',
            enum: ['restricted'],
          },
        },
      },
      expected: {
        type: 'object',
        properties: {
          'with/slash': {
            definitions: { 'value/name': { type: 'string' } },
            $ref: '#/properties/with~1slash/definitions/value~1name',
            enum: ['restricted'],
          },
        },
      },
    },
    {
      name: 'percent-encoded slash in nested definition',
      schema: {
        type: 'object',
        properties: {
          scoped: {
            definitions: { 'value/name': { type: 'string' } },
            $ref: '#/definitions/value%2Fname',
          },
        },
      },
      expected: {
        type: 'object',
        properties: {
          scoped: {
            definitions: { 'value/name': { type: 'string' } },
            $ref: '#/properties/scoped/definitions/value~1name',
          },
        },
      },
    },
    {
      name: 'valid root reference wins over a same-name local definition',
      schema: {
        $defs: { Entry: { type: 'integer' } },
        properties: {
          scoped: { $defs: { Entry: { type: 'string' } }, $ref: '#/$defs/Entry' },
        },
      },
    },
    {
      name: 'nested recursive reference retains recursion',
      schema: {
        properties: {
          tree: {
            $defs: { Node: { properties: { next: { $ref: '#/$defs/Node' } } } },
            $ref: '#/$defs/Node',
          },
        },
      },
      expected: {
        properties: {
          tree: {
            $defs: {
              Node: { properties: { next: { $ref: '#/properties/tree/$defs/Node' } } },
            },
            $ref: '#/properties/tree/$defs/Node',
          },
        },
      },
    },
    {
      name: 'unresolved reference is not silently discarded',
      schema: { type: 'object', properties: { unknown: { $ref: '#/$defs/Missing' } } },
    },
    {
      name: 'malformed pointer escapes remain visible to upstream validation',
      schema: {
        properties: {
          scoped: { $defs: { 'bad~2': { type: 'string' } }, $ref: '#/$defs/bad~2' },
        },
      },
    },
    {
      name: 'nested resource keeps its own fragment base',
      schema: {
        properties: {
          resource: {
            $id: 'https://schemas.example.test/resource',
            $defs: { Entry: { type: 'string' } },
            $ref: '#/$defs/Entry',
          },
        },
      },
    },
    {
      name: 'external reference is not fetched or rewritten',
      schema: { $ref: 'https://schemas.example.test/external', minLength: 3 },
    },
  ];
  let upstreamBody: JsonRecord | undefined;
  const bridge = createAnthropicOpenAiBridgeServer({}, {
    fetchImpl: async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as JsonRecord;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const bridgeUrl = await listen(bridge);
  try {
    for (const fixture of cases) {
      const response = await fetch(`${bridgeUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'schema-boundary-test-token' },
        body: JSON.stringify({
          model: 'schema-test-model',
          messages: [{ role: 'user', content: 'Inspect the schema.' }],
          tools: [{ name: 'inspect', input_schema: fixture.schema }],
        }),
      });
      assert.equal(response.status, 200, fixture.name);
      assert.deepEqual(upstreamBody?.tools, [{
        type: 'function',
        function: { name: 'inspect', parameters: fixture.expected ?? fixture.schema },
      }], fixture.name);
    }
  } finally {
    await close(bridge);
  }
});

test('translates OpenAI streaming reasoning, text, and split tool calls into Anthropic SSE', async () => {
  let upstreamAuthorization: string | undefined;
  const upstream = http.createServer((request, response) => {
    void (async () => {
      upstreamAuthorization = request.headers.authorization;
      await readJsonBody(request);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      writeOpenAiSse(response, {
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      writeOpenAiSse(response, {
        choices: [{ index: 0, delta: { reasoning_content: 'Think.' }, finish_reason: null }],
      });
      writeOpenAiSse(response, {
        choices: [{ index: 0, delta: { content: 'Answer.' }, finish_reason: null }],
      });
      writeOpenAiSse(response, {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-stream-tool',
              type: 'function',
              function: { name: 'ec', arguments: '{"value":' },
            }],
          },
          finish_reason: null,
        }],
      });
      writeOpenAiSse(response, {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'ho', arguments: '"stream"}' },
            }],
          },
          finish_reason: null,
        }],
      });
      writeOpenAiSse(response, {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
      writeOpenAiSse(response, {
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 9 },
      });
      response.end('data: [DONE]\n\n');
    })();
  });
  const upstreamUrl = await listen(upstream);
  let nextId = 0;
  const bridge = createAnthropicOpenAiBridgeServer({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    upstreamModel: 'kimi-k2.6',
  }, {
    idFactory: () => `stream-${++nextId}`,
  });
  const bridgeUrl = await listen(bridge);

  try {
    const bridgeResponse = await fetch(`${bridgeUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer stream-test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-k2.6',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'Use the tool.' }],
        tools: [{
          name: 'echo',
          input_schema: { type: 'object', properties: { value: { type: 'string' } } },
        }],
      }),
    });

    assert.equal(bridgeResponse.status, 200);
    assert.match(bridgeResponse.headers.get('content-type') ?? '', /text\/event-stream/);
    const responseText = await bridgeResponse.text();
    assert.doesNotMatch(responseText, /stream-test-key/);
    assert.equal(upstreamAuthorization, 'Bearer stream-test-key');
    const events = parseAnthropicSse(responseText);
    assert.deepEqual(events.map((entry) => entry.event), [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    assert.deepEqual(events[1]?.data, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    });
    assert.deepEqual(events[2]?.data, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Think.' },
    });
    assert.match(JSON.stringify(events[3]?.data), /signature_delta.*bridge_/);
    assert.deepEqual(events[5]?.data, {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    });
    assert.deepEqual(events[6]?.data, {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Answer.' },
    });
    assert.deepEqual(events[8]?.data, {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'tool_use',
        id: 'call-stream-tool',
        name: 'echo',
        input: {},
      },
    });
    assert.deepEqual(events[9]?.data, {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"value":"stream"}' },
    });
    assert.deepEqual(events[11]?.data, {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: {
        input_tokens: 20,
        output_tokens: 9,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  } finally {
    await close(bridge);
    await close(upstream);
  }
});

test('keeps the upstream timeout active after streaming headers arrive', async () => {
  const upstream = http.createServer((request, response) => {
    void (async () => {
      await readJsonBody(request);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      writeOpenAiSse(response, {
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      // Deliberately leave the stream open. The bridge timeout must abort it.
    })();
  });
  const upstreamUrl = await listen(upstream);
  const bridge = createAnthropicOpenAiBridgeServer({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
    upstreamTimeoutMs: 75,
  });
  const bridgeUrl = await listen(bridge);

  try {
    const startedAt = Date.now();
    const bridgeResponse = await fetch(`${bridgeUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer timeout-test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-k2.6',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'Wait.' }],
      }),
    });
    const responseText = await bridgeResponse.text();
    assert.ok(Date.now() - startedAt < 2_000);
    assert.match(responseText, /event: error/);
    assert.match(responseText, /Anthropic compatibility bridge failed/);
    assert.doesNotMatch(responseText, /timeout-test-key/);
  } finally {
    await close(bridge);
    await close(upstream);
  }
});

test('sanitizes upstream error bodies and caller credentials', async () => {
  const upstream = http.createServer((request, response) => {
    void (async () => {
      await readJsonBody(request);
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('upstream-secret-marker caller-secret-key');
    })();
  });
  const upstreamUrl = await listen(upstream);
  const bridge = createAnthropicOpenAiBridgeServer({
    upstreamBaseUrl: `${upstreamUrl}/v1`,
  });
  const bridgeUrl = await listen(bridge);

  try {
    const bridgeResponse = await fetch(`${bridgeUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': 'caller-secret-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-k2.6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Fail safely.' }],
      }),
    });
    assert.equal(bridgeResponse.status, 502);
    const responseText = await bridgeResponse.text();
    assert.deepEqual(JSON.parse(responseText), {
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Dataverse upstream returned HTTP 502.',
      },
    });
    assert.doesNotMatch(responseText, /upstream-secret-marker|caller-secret-key/);
  } finally {
    await close(bridge);
    await close(upstream);
  }
});
