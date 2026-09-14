import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const DEFAULT_UPSTREAM_BASE_URL = 'http://127.0.0.1:3082/v1';
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30 * 60 * 1000;
const SSE_PING_INTERVAL_MS = 10_000;

type JsonRecord = Record<string, unknown>;

type AnthropicOpenAiBridgeOptions = {
  upstreamBaseUrl?: string;
  upstreamModel?: string;
  reasoningEffort?: string;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
  forwardReasoning?: boolean;
};

type AnthropicOpenAiBridgeDependencies = {
  fetchImpl?: typeof fetch;
  idFactory?: () => string;
};

type OpenAiToolAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

class BridgeHttpError extends Error {
  readonly statusCode: number;
  readonly errorType: string;

  constructor(statusCode: number, errorType: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorType = errorType;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
  });
  response.end(encoded);
}

function writeAnthropicError(
  response: ServerResponse,
  statusCode: number,
  errorType: string,
  message: string,
): void {
  writeJson(response, statusCode, {
    type: 'error',
    error: { type: errorType, message },
  });
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    receivedBytes += chunk.length;
    if (receivedBytes > maxBodyBytes) {
      throw new BridgeHttpError(413, 'invalid_request_error', 'Request body is too large.');
    }
    chunks.push(chunk);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new BridgeHttpError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
}

function readRequestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return readString(value[0]);
  }
  return readString(value);
}

function resolveUpstreamToken(request: IncomingMessage): string | undefined {
  const authorization = readRequestHeader(request, 'authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return readString(authorization.slice(7));
  }
  return readRequestHeader(request, 'x-api-key');
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return isRecord(value) ? JSON.stringify(value) : String(value ?? '');
  }

  return value
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }
      if (!isRecord(block)) {
        return '';
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      if (block.type === 'image') {
        return '[image attachment]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function convertRegularContentBlocks(blocks: unknown[]): string | JsonRecord[] {
  const converted: JsonRecord[] = [];

  for (const block of blocks) {
    if (typeof block === 'string') {
      converted.push({ type: 'text', text: block });
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      converted.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type === 'image' && isRecord(block.source)) {
      const sourceType = readString(block.source.type);
      const mediaType = readString(block.source.media_type);
      const data = readString(block.source.data);
      const url = readString(block.source.url);
      if (sourceType === 'base64' && mediaType && data) {
        converted.push({
          type: 'image_url',
          image_url: { url: `data:${mediaType};base64,${data}` },
        });
      } else if (sourceType === 'url' && url) {
        converted.push({ type: 'image_url', image_url: { url } });
      }
      continue;
    }

    if (block.type === 'document' && isRecord(block.source)) {
      const documentText = readString(block.source.text)
        ?? readString(block.source.content);
      if (documentText) {
        converted.push({ type: 'text', text: documentText });
      }
    }
  }

  if (converted.every((entry) => entry.type === 'text')) {
    return converted.map((entry) => String(entry.text ?? '')).join('\n');
  }
  return converted;
}

function convertUserMessage(content: unknown): JsonRecord[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }];
  }
  if (!Array.isArray(content)) {
    return [{ role: 'user', content: textFromContent(content) }];
  }

  const messages: JsonRecord[] = [];
  let regularBlocks: unknown[] = [];
  const flushRegularBlocks = () => {
    if (regularBlocks.length === 0) {
      return;
    }
    messages.push({ role: 'user', content: convertRegularContentBlocks(regularBlocks) });
    regularBlocks = [];
  };

  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') {
      regularBlocks.push(block);
      continue;
    }

    flushRegularBlocks();
    const toolUseId = readString(block.tool_use_id);
    if (!toolUseId) {
      continue;
    }
    const toolText = textFromContent(block.content);
    messages.push({
      role: 'tool',
      tool_call_id: toolUseId,
      content: block.is_error === true ? `Tool error: ${toolText}` : toolText,
    });
  }
  flushRegularBlocks();

  return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
}

function convertAssistantMessage(content: unknown): JsonRecord {
  if (typeof content === 'string') {
    return { role: 'assistant', content };
  }
  if (!Array.isArray(content)) {
    return { role: 'assistant', content: textFromContent(content) };
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: JsonRecord[] = [];

  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoningParts.push(block.thinking);
    } else if (block.type === 'tool_use') {
      const id = readString(block.id);
      const name = readString(block.name);
      if (id && name) {
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
    }
  }

  return {
    role: 'assistant',
    content: textParts.join('\n') || null,
    ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join('\n') } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function convertSystemMessage(system: unknown): JsonRecord | null {
  const text = textFromContent(system);
  return text ? { role: 'system', content: text } : null;
}

function encodeSchemaPointerToken(value: string): string {
  return encodeURIComponent(value.replaceAll('~', '~0').replaceAll('/', '~1'));
}

function hasSchemaPointer(root: unknown, segments: readonly string[]): boolean {
  let current = root;
  for (const segment of segments) {
    if ((!isRecord(current) && !Array.isArray(current))
      || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return false;
    }
    current = (current as JsonRecord)[segment];
  }
  return true;
}

/**
 * Repairs one MCP compatibility defect observed in the deployed bridge's
 * regression fixture: a nested `$defs`/`definitions` table accompanied by a
 * document-root reference to that local table. Rewrite only such unresolved
 * root references to the actual definition pointer. Valid root references,
 * recursive schemas, booleans, annotations and constraints remain intact.
 * This is not a JSON Schema validator or a lossy upstream schema converter;
 * unresolved/external references remain visible to the upstream validator.
 */
function normalizeOpenAiToolSchema(
  value: unknown,
  root: unknown = value,
  pointer = '',
  scopes: readonly { keyword: string; pointer: string; definitions: JsonRecord }[] = [],
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  // A nested $id starts a separate schema resource with its own fragment
  // resolution rules. Leave it untouched instead of guessing a document-root
  // pointer across that boundary.
  if (pointer && readString(value.$id)) {
    return value;
  }
  const localScopes = [...scopes];
  for (const keyword of ['$defs', 'definitions']) {
    if (isRecord(value[keyword])) {
      localScopes.push({
        keyword,
        pointer: `${pointer}/${keyword}`,
        definitions: value[keyword],
      });
    }
  }

  const normalized: JsonRecord = { ...value };
  const reference = readString(value.$ref);
  if (reference?.startsWith('#/$defs/') || reference?.startsWith('#/definitions/')) {
    let segments: string[] = [];
    try {
      // RFC 6901 sections 3 and 6: decode the URI fragment before parsing the
      // JSON Pointer. An encoded slash is a path separator; a slash within a
      // definition name must use the JSON Pointer escape `~1`.
      const source = decodeURIComponent(reference.slice(2));
      if (!/~(?:[^01]|$)/.test(source)) {
        segments = source.split('/').map((segment) => (
          segment.replaceAll('~1', '/').replaceAll('~0', '~')
        ));
      }
    } catch {
      // Malformed URI escapes are left for the upstream validator.
    }
    if (segments.length > 1 && !hasSchemaPointer(root, segments)) {
      const keyword = segments[0];
      const definitionSegments = segments.slice(1);
      const scope = [...localScopes].reverse().find((candidate) => (
        candidate.keyword === keyword
        && hasSchemaPointer(candidate.definitions, definitionSegments)
      ));
      if (scope) {
        normalized.$ref = `#${scope.pointer}/${definitionSegments.map(encodeSchemaPointerToken).join('/')}`;
      }
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    const childPointer = `${pointer}/${encodeSchemaPointerToken(key)}`;
    if (['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'].includes(key)
      && isRecord(entry)) {
      normalized[key] = Object.fromEntries(Object.entries(entry).map(([name, schema]) => [
        name,
        normalizeOpenAiToolSchema(schema, root, `${childPointer}/${encodeSchemaPointerToken(name)}`, localScopes),
      ]));
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'].includes(key)
      && Array.isArray(entry)) {
      normalized[key] = entry.map((schema, index) => (
        normalizeOpenAiToolSchema(schema, root, `${childPointer}/${index}`, localScopes)
      ));
    } else if ([
      'items', 'contains', 'propertyNames', 'not', 'if', 'then', 'else',
      'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems',
    ].includes(key)) {
      normalized[key] = normalizeOpenAiToolSchema(entry, root, childPointer, localScopes);
    }
    // Other values (notably default/enum/const/examples) are user data. Never
    // recurse into them or strip keys that happen to look like schema syntax.
  }
  return normalized;
}

function convertTools(tools: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const converted = tools.flatMap((tool): JsonRecord[] => {
    if (!isRecord(tool)) {
      return [];
    }
    const name = readString(tool.name);
    if (!name) {
      return [];
    }
    return [{
      type: 'function',
      function: {
        name,
        ...(readString(tool.description) ? { description: readString(tool.description) } : {}),
        parameters: isRecord(tool.input_schema)
          ? normalizeOpenAiToolSchema(tool.input_schema)
          : { type: 'object', properties: {} },
      },
    }];
  });

  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice)) {
    return undefined;
  }
  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool': {
      const name = readString(toolChoice.name);
      return name ? { type: 'function', function: { name } } : undefined;
    }
    default:
      return undefined;
  }
}

function buildOpenAiRequest(
  requestBody: JsonRecord,
  options: Required<AnthropicOpenAiBridgeOptions>,
): JsonRecord {
  const messages: JsonRecord[] = [];
  const systemMessage = convertSystemMessage(requestBody.system);
  if (systemMessage) {
    messages.push(systemMessage);
  }

  if (!Array.isArray(requestBody.messages)) {
    throw new BridgeHttpError(400, 'invalid_request_error', 'messages must be an array.');
  }

  for (const message of requestBody.messages) {
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === 'assistant') {
      messages.push(convertAssistantMessage(message.content));
    } else if (message.role === 'user') {
      messages.push(...convertUserMessage(message.content));
    }
  }

  const requestedModel = readString(requestBody.model);
  const model = options.upstreamModel || requestedModel;
  if (!model) {
    throw new BridgeHttpError(400, 'invalid_request_error', 'model is required.');
  }

  const tools = convertTools(requestBody.tools);
  const toolChoice = convertToolChoice(requestBody.tool_choice);
  const toolChoiceRecord = isRecord(requestBody.tool_choice) ? requestBody.tool_choice : null;
  const stopSequences = Array.isArray(requestBody.stop_sequences)
    ? requestBody.stop_sequences.filter((value): value is string => typeof value === 'string')
    : undefined;

  return {
    model,
    messages,
    max_tokens: readFiniteNumber(requestBody.max_tokens) ?? 8192,
    stream: requestBody.stream === true,
    ...(requestBody.stream === true ? { stream_options: { include_usage: true } } : {}),
    ...(readFiniteNumber(requestBody.temperature) !== undefined
      ? { temperature: readFiniteNumber(requestBody.temperature) }
      : {}),
    ...(readFiniteNumber(requestBody.top_p) !== undefined
      ? { top_p: readFiniteNumber(requestBody.top_p) }
      : {}),
    ...(stopSequences && stopSequences.length > 0 ? { stop: stopSequences } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(toolChoiceRecord && typeof toolChoiceRecord.disable_parallel_tool_use === 'boolean'
      ? { parallel_tool_calls: !toolChoiceRecord.disable_parallel_tool_use }
      : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
  };
}

function mapStopReason(finishReason: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls || finishReason === 'tool_calls' || finishReason === 'function_call') {
    return 'tool_use';
  }
  if (finishReason === 'length') {
    return 'max_tokens';
  }
  return 'end_turn';
}

function buildAnthropicUsage(usage: OpenAiUsage | undefined): JsonRecord {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function buildThinkingSignature(messageId: string, thinking: string): string {
  return `bridge_${createHash('sha256').update(messageId).update(thinking).digest('base64url')}`;
}

function translateNonStreamingCompletion(
  completion: JsonRecord,
  requestedModel: string,
  idFactory: () => string,
  forwardReasoning: boolean,
): JsonRecord {
  const choice = Array.isArray(completion.choices) && isRecord(completion.choices[0])
    ? completion.choices[0]
    : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const messageId = `msg_bridge_${idFactory()}`;
  const content: JsonRecord[] = [];
  const reasoning = readString(message.reasoning_content);
  const text = typeof message.content === 'string' ? message.content : '';

  if (forwardReasoning && reasoning) {
    content.push({
      type: 'thinking',
      thinking: reasoning,
      signature: buildThinkingSignature(messageId, reasoning),
    });
  }
  if (text) {
    content.push({ type: 'text', text });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
      continue;
    }
    const id = readString(toolCall.id) ?? `toolu_bridge_${idFactory()}`;
    const name = readString(toolCall.function.name) ?? 'unknown_tool';
    const rawArguments = typeof toolCall.function.arguments === 'string'
      ? toolCall.function.arguments
      : '{}';
    let input: JsonRecord = {};
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      input = isRecord(parsed) ? parsed : {};
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id, name, input });
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: buildAnthropicUsage(isRecord(completion.usage) ? completion.usage as OpenAiUsage : undefined),
  };
}

function findSseBoundary(buffer: string): { index: number; length: number } | null {
  const unixIndex = buffer.indexOf('\n\n');
  const windowsIndex = buffer.indexOf('\r\n\r\n');
  if (unixIndex < 0 && windowsIndex < 0) {
    return null;
  }
  if (windowsIndex >= 0 && (unixIndex < 0 || windowsIndex < unixIndex)) {
    return { index: windowsIndex, length: 4 };
  }
  return { index: unixIndex, length: 2 };
}

function readSseFrameData(frame: string): string | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let boundary = findSseBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = readSseFrameData(frame);
        if (data !== null) {
          yield data;
        }
        boundary = findSseBoundary(buffer);
      }

      if (done) {
        const data = readSseFrameData(buffer);
        if (data !== null) {
          yield data;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeWithBackpressure(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error('Client connection closed.');
  }
  if (!response.write(chunk)) {
    await once(response, 'drain');
  }
}

async function writeSseEvent(
  response: ServerResponse,
  eventName: string,
  body: unknown,
): Promise<void> {
  await writeWithBackpressure(
    response,
    `event: ${eventName}\ndata: ${JSON.stringify(body)}\n\n`,
  );
}

async function translateStreamingCompletion(
  upstreamBody: ReadableStream<Uint8Array>,
  response: ServerResponse,
  requestedModel: string,
  idFactory: () => string,
  forwardReasoning: boolean,
): Promise<void> {
  const messageId = `msg_bridge_${idFactory()}`;
  let nextBlockIndex = 0;
  let openBlock: { type: 'thinking' | 'text'; index: number; content: string } | null = null;
  let finishReason: unknown = null;
  let usage: OpenAiUsage | undefined;
  const tools = new Map<number, OpenAiToolAccumulator>();

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'request-id': `req_bridge_${idFactory()}`,
  });

  await writeSseEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

  const closeOpenBlock = async () => {
    if (!openBlock) {
      return;
    }
    if (openBlock.type === 'thinking') {
      await writeSseEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: openBlock.index,
        delta: {
          type: 'signature_delta',
          signature: buildThinkingSignature(messageId, openBlock.content),
        },
      });
    }
    await writeSseEvent(response, 'content_block_stop', {
      type: 'content_block_stop',
      index: openBlock.index,
    });
    openBlock = null;
  };

  const writeTextualDelta = async (type: 'thinking' | 'text', text: string) => {
    if (!text) {
      return;
    }
    if (openBlock?.type !== type) {
      await closeOpenBlock();
      const index = nextBlockIndex;
      nextBlockIndex += 1;
      openBlock = { type, index, content: '' };
      await writeSseEvent(response, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: type === 'thinking'
          ? { type: 'thinking', thinking: '' }
          : { type: 'text', text: '' },
      });
    }
    openBlock.content += text;
    await writeSseEvent(response, 'content_block_delta', {
      type: 'content_block_delta',
      index: openBlock.index,
      delta: type === 'thinking'
        ? { type: 'thinking_delta', thinking: text }
        : { type: 'text_delta', text },
    });
  };

  const pingTimer = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(`event: ping\ndata: {"type":"ping"}\n\n`);
    }
  }, SSE_PING_INTERVAL_MS);
  pingTimer.unref?.();

  try {
    for await (const data of readSseData(upstreamBody)) {
      if (data === '[DONE]') {
        break;
      }

      let chunk: JsonRecord;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (!isRecord(parsed)) {
          throw new Error('invalid chunk');
        }
        chunk = parsed;
      } catch {
        throw new Error('Dataverse returned an invalid streaming event.');
      }

      if (chunk.error) {
        throw new Error('Dataverse streaming request failed.');
      }
      if (isRecord(chunk.usage)) {
        usage = chunk.usage as OpenAiUsage;
      }

      const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0])
        ? chunk.choices[0]
        : null;
      if (!choice) {
        continue;
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const reasoning = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : '';
      const text = typeof delta.content === 'string' ? delta.content : '';
      if (forwardReasoning && reasoning) {
        await writeTextualDelta('thinking', reasoning);
      }
      if (text) {
        await writeTextualDelta('text', text);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const rawToolCall of delta.tool_calls) {
          if (!isRecord(rawToolCall)) {
            continue;
          }
          const toolIndex = readFiniteNumber(rawToolCall.index) ?? 0;
          const accumulator = tools.get(toolIndex) ?? { id: '', name: '', arguments: '' };
          const toolId = readString(rawToolCall.id);
          if (toolId) {
            accumulator.id = toolId;
          }
          if (isRecord(rawToolCall.function)) {
            if (typeof rawToolCall.function.name === 'string') {
              accumulator.name += rawToolCall.function.name;
            }
            if (typeof rawToolCall.function.arguments === 'string') {
              accumulator.arguments += rawToolCall.function.arguments;
            }
          }
          tools.set(toolIndex, accumulator);
        }
      }
    }

    await closeOpenBlock();
    for (const [, tool] of [...tools.entries()].sort(([left], [right]) => left - right)) {
      const index = nextBlockIndex;
      nextBlockIndex += 1;
      await writeSseEvent(response, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: tool.id || `toolu_bridge_${idFactory()}`,
          name: tool.name || 'unknown_tool',
          input: {},
        },
      });
      await writeSseEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: tool.arguments || '{}',
        },
      });
      await writeSseEvent(response, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      });
    }

    await writeSseEvent(response, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapStopReason(finishReason, tools.size > 0),
        stop_sequence: null,
      },
      usage: buildAnthropicUsage(usage),
    });
    await writeSseEvent(response, 'message_stop', { type: 'message_stop' });
    response.end();
  } finally {
    clearInterval(pingTimer);
  }
}

function estimateTokenCount(value: unknown, key = ''): number {
  if (typeof value === 'string') {
    if (key === 'data' && value.length > 1024) {
      return 1024;
    }
    return Math.ceil(value.length / 4);
  }
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + estimateTokenCount(entry), 0);
  }
  if (isRecord(value)) {
    return Object.entries(value).reduce(
      (total, [entryKey, entryValue]) => total + estimateTokenCount(entryValue, entryKey),
      0,
    );
  }
  return 0;
}

function mapUpstreamErrorType(statusCode: number): string {
  if (statusCode === 400) return 'invalid_request_error';
  if (statusCode === 401 || statusCode === 403) return 'authentication_error';
  if (statusCode === 429) return 'rate_limit_error';
  return 'api_error';
}

/**
 * Used by the standalone 3090 pilot sidecar process and focused tests to
 * expose Anthropic Messages semantics over a Dataverse OpenAI-compatible API.
 * The returned server never stores credentials: it forwards the caller's
 * in-memory Anthropic credential as an upstream bearer token.
 */
export function createAnthropicOpenAiBridgeServer(
  optionOverrides: AnthropicOpenAiBridgeOptions = {},
  dependencyOverrides: AnthropicOpenAiBridgeDependencies = {},
): Server {
  const options: Required<AnthropicOpenAiBridgeOptions> = {
    upstreamBaseUrl: optionOverrides.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL,
    upstreamModel: optionOverrides.upstreamModel ?? '',
    reasoningEffort: optionOverrides.reasoningEffort ?? '',
    maxBodyBytes: optionOverrides.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    upstreamTimeoutMs: optionOverrides.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    forwardReasoning: optionOverrides.forwardReasoning ?? true,
  };
  const fetchImpl = dependencyOverrides.fetchImpl ?? fetch;
  const idFactory = dependencyOverrides.idFactory ?? randomUUID;
  const upstreamMessagesUrl = `${options.upstreamBaseUrl.replace(/\/+$/, '')}/chat/completions`;

  return http.createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        writeJson(response, 200, {
          status: 'ok',
          service: 'comic-anthropic-openai-bridge',
        });
        return;
      }

      if (request.method !== 'POST') {
        throw new BridgeHttpError(404, 'not_found_error', 'Endpoint not found.');
      }

      const token = resolveUpstreamToken(request);
      if (!token) {
        throw new BridgeHttpError(
          401,
          'authentication_error',
          'An Anthropic API key or bearer token is required.',
        );
      }

      const requestBody = await readJsonBody(request, options.maxBodyBytes);
      if (requestUrl.pathname === '/v1/messages/count_tokens') {
        writeJson(response, 200, {
          input_tokens: Math.max(1, estimateTokenCount(requestBody)),
        });
        return;
      }

      if (requestUrl.pathname !== '/v1/messages') {
        throw new BridgeHttpError(404, 'not_found_error', 'Endpoint not found.');
      }

      const openAiRequest = buildOpenAiRequest(requestBody, options);
      const requestedModel = readString(requestBody.model)
        ?? options.upstreamModel
        ?? 'unknown';
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), options.upstreamTimeoutMs);
      timeout.unref?.();
      const abortOnDisconnect = () => {
        if (!response.writableEnded) {
          abortController.abort();
        }
      };
      request.once('aborted', abortOnDisconnect);
      response.once('close', abortOnDisconnect);

      try {
        const upstreamResponse = await fetchImpl(upstreamMessagesUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(openAiRequest),
          signal: abortController.signal,
        });

        if (!upstreamResponse.ok) {
          try {
            await upstreamResponse.body?.cancel();
          } catch {
            // The response body is intentionally discarded so upstream details,
            // which can contain credentials, never reach a client or log.
          }
          throw new BridgeHttpError(
            upstreamResponse.status,
            mapUpstreamErrorType(upstreamResponse.status),
            `Dataverse upstream returned HTTP ${upstreamResponse.status}.`,
          );
        }

        if (requestBody.stream === true) {
          if (!upstreamResponse.body) {
            throw new BridgeHttpError(502, 'api_error', 'Dataverse returned an empty stream.');
          }
          await translateStreamingCompletion(
            upstreamResponse.body,
            response,
            requestedModel,
            idFactory,
            options.forwardReasoning,
          );
          return;
        }

        let completion: unknown;
        try {
          completion = await upstreamResponse.json();
        } catch {
          throw new BridgeHttpError(502, 'api_error', 'Dataverse returned invalid JSON.');
        }
        if (!isRecord(completion)) {
          throw new BridgeHttpError(502, 'api_error', 'Dataverse returned an invalid response.');
        }
        writeJson(response, 200, translateNonStreamingCompletion(
          completion,
          requestedModel,
          idFactory,
          options.forwardReasoning,
        ));
      } finally {
        clearTimeout(timeout);
        request.off('aborted', abortOnDisconnect);
        response.off('close', abortOnDisconnect);
      }
    })().catch((error: unknown) => {
      if (response.writableEnded || response.destroyed) {
        return;
      }
      const normalized = error instanceof BridgeHttpError
        ? error
        : new BridgeHttpError(502, 'api_error', 'Anthropic compatibility bridge failed.');

      if (response.headersSent) {
        void writeSseEvent(response, 'error', {
          type: 'error',
          error: { type: normalized.errorType, message: normalized.message },
        }).finally(() => response.end());
        return;
      }
      writeAnthropicError(
        response,
        normalized.statusCode,
        normalized.errorType,
        normalized.message,
      );
    });
  });
}
