#!/usr/bin/env node

/**
 * Small stdio-to-HTTP MCP adapter used by the Claude Web runtime.
 *
 * The Dataverse Anthropic-compatible endpoint currently rejects JSON Schema
 * `$ref` entries that are valid in the upstream ThinkingData MCP definition.
 * Claude Code discovers tools through this process, so the adapter only
 * normalizes `tools/list`; every other JSON-RPC request and tool result is
 * forwarded to the original MCP endpoint unchanged.
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;
type JsonValue = JsonRecord | unknown[] | string | number | boolean | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonRecord;
};

type ProxyState = {
  sessionId: string | null;
  protocolVersion: string;
};

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const MAX_REFERENCE_EXPANSION_DEPTH = 4;
// MCP discovery/tool responses are small JSON documents. Bound both how long
// an upstream may keep a PTY child waiting and how much data it can make the
// proxy buffer; a stalled or unexpectedly large response must not consume a
// shared CloudCLI process indefinitely.
const UPSTREAM_REQUEST_TIMEOUT_MS = 60_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readConfiguredUpstreamUrl(): string {
  const rawUrl = readNonEmpty(process.env.CLOUDCLI_THINKINGDATA_MCP_URL);
  if (!rawUrl) {
    throw new Error('ThinkingData MCP upstream URL is not configured.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('ThinkingData MCP upstream URL is invalid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ThinkingData MCP upstream URL must use HTTP or HTTPS.');
  }
  return parsed.toString();
}

function readConfiguredTokenFile(): string | undefined {
  const tokenFilePath = readNonEmpty(
    process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE,
  );
  if (!tokenFilePath) {
    return undefined;
  }

  try {
    return readNonEmpty(readFileSync(tokenFilePath, 'utf8'));
  } catch {
    // The proxy may still have been launched by a client that inherits the
    // token environment. Keep file errors generic and fall through without
    // exposing the protected path or filesystem details.
    return undefined;
  }
}

/**
 * Used by the compatibility proxy startup and focused tests to resolve its
 * credential without serializing the secret into Claude's `--mcp-config`.
 * A host-owned protected file is preferred because Claude Code does not pass
 * arbitrary parent variables to stdio MCP children; inherited variables stay
 * as a compatibility fallback for direct launches.
 */
export function readConfiguredToken(): string {
  const configuredEnvironmentName = readNonEmpty(
    process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV,
  ) ?? 'TE_MCP_TOKEN';
  const token = readConfiguredTokenFile()
    ?? readNonEmpty(process.env[configuredEnvironmentName])
    ?? readNonEmpty(process.env.TE_MCP_TOKEN);
  if (!token) {
    throw new Error('ThinkingData MCP credentials are unavailable.');
  }
  return token;
}

function definitionMapForSchema(
  schema: JsonRecord,
  inherited: Map<string, JsonRecord>,
): Map<string, JsonRecord> {
  const definitions = new Map(inherited);
  for (const [containerKey, referencePrefix] of [
    ['$defs', '#/$defs/'],
    ['definitions', '#/definitions/'],
  ] as const) {
    const container = schema[containerKey];
    if (!isRecord(container)) {
      continue;
    }
    for (const [name, definition] of Object.entries(container)) {
      if (!isRecord(definition)) {
        continue;
      }
      definitions.set(`${referencePrefix}${name}`, definition);
      // A few schema generators emit a bare definition name in addition to
      // the standard JSON Pointer. Supporting it costs nothing and keeps the
      // bridge tolerant of future ThinkingData schema versions.
      definitions.set(name, definition);
    }
  }
  return definitions;
}

function referenceTarget(
  reference: string,
  definitions: Map<string, JsonRecord>,
): JsonRecord | undefined {
  return definitions.get(reference)
    ?? (reference.startsWith('#/$defs/')
      ? definitions.get(reference.slice('#/$defs/'.length))
      : undefined)
    ?? (reference.startsWith('#/definitions/')
      ? definitions.get(reference.slice('#/definitions/'.length))
      : undefined);
}

function cycleFallback(target: JsonRecord | undefined): JsonRecord {
  const targetType = readNonEmpty(target?.type);
  if (targetType === 'array') {
    return { type: 'array', items: {} };
  }
  if (targetType === 'string' || targetType === 'number' || targetType === 'integer'
    || targetType === 'boolean' || targetType === 'null') {
    return { type: targetType };
  }
  return { type: 'object' };
}

function mergeSchemaRecords(base: JsonValue, overlay: JsonRecord): JsonRecord {
  return {
    ...(isRecord(base) ? base : {}),
    ...overlay,
  };
}

function resolveSchemaNode(
  value: unknown,
  inheritedDefinitions: Map<string, JsonRecord>,
  activeReferences: Set<string>,
  depth: number,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveSchemaNode(
      entry,
      inheritedDefinitions,
      activeReferences,
      depth,
    ));
  }
  if (!isRecord(value)) {
    return value as JsonValue;
  }

  const definitions = definitionMapForSchema(value, inheritedDefinitions);
  const reference = readNonEmpty(value.$ref);
  if (reference) {
    const target = referenceTarget(reference, definitions);
    const canExpand = Boolean(target)
      && !activeReferences.has(reference)
      && depth < MAX_REFERENCE_EXPANSION_DEPTH;
    const expandedTarget = canExpand
      ? resolveSchemaNode(
        target,
        definitions,
        new Set([...activeReferences, reference]),
        depth + 1,
      )
      : cycleFallback(target);
    const overlay: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref' || key === '$defs' || key === 'definitions' || key === '$schema') {
        continue;
      }
      overlay[key] = resolveSchemaNode(entry, definitions, activeReferences, depth);
    }
    return mergeSchemaRecords(expandedTarget, overlay);
  }

  const output: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    // `$schema` is descriptive metadata and `$defs`/`definitions` are no
    // longer needed after the local references have been inlined. Removing
    // them also keeps the payload accepted by stricter model gateways.
    if (key === '$schema' || key === '$defs' || key === 'definitions' || key === '$ref') {
      continue;
    }
    output[key] = resolveSchemaNode(entry, definitions, activeReferences, depth);
  }
  return output;
}

/**
 * Used by the Claude MCP compatibility process and its focused tests to
 * inline local JSON Schema references. Recursive definitions are bounded and
 * replaced with a type-preserving object/array fallback so a malformed or
 * cyclic schema cannot make the child process recurse forever.
 */
export function dereferenceJsonSchema(schema: unknown): Record<string, unknown> {
  const resolved = resolveSchemaNode(schema, new Map(), new Set(), 0);
  return isRecord(resolved) ? resolved : { type: 'object', properties: {} };
}

/**
 * Used by the MCP proxy when responding to `tools/list`; tool metadata stays
 * intact while only the input schema is normalized for Claude's gateway.
 */
export function sanitizeMcpToolSchemas(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!isRecord(tool)) {
      return tool;
    }

    const sanitizedTool = { ...tool };
    let changed = false;
    for (const schemaKey of ['inputSchema', 'input_schema'] as const) {
      const inputSchema = tool[schemaKey];
      if (!isRecord(inputSchema)) {
        continue;
      }
      sanitizedTool[schemaKey] = dereferenceJsonSchema(inputSchema);
      changed = true;
    }
    return changed ? sanitizedTool : tool;
  });
}

function extractSseJson(text: string, expectedId: string | number | null | undefined): JsonRecord | null {
  const candidates: JsonRecord[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed)) {
        candidates.push(parsed);
      }
    } catch {
      // Ignore non-JSON SSE comments/events and continue looking for the RPC
      // response frame.
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.find((candidate) => candidate.id === expectedId)
    ?? candidates[candidates.length - 1];
}

function parseUpstreamResponse(
  text: string,
  expectedId: string | number | null | undefined,
): JsonRecord | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return extractSseJson(trimmed, expectedId);
  }
}

function writeMessage(message: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeError(
  id: string | number | null | undefined,
  message: string,
): void {
  writeMessage({
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32000,
      message,
    },
  });
}

/**
 * Reads one upstream response with a hard byte ceiling. `Response.text()`
 * buffers without a limit, so using the stream reader here is part of the
 * credential/network boundary rather than merely an optimization.
 */
async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error('ThinkingData MCP upstream response is too large.');
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_RESPONSE_BYTES) {
      throw new Error('ThinkingData MCP upstream response is too large.');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('ThinkingData MCP upstream response is too large.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function forwardRequest(
  upstreamUrl: string,
  token: string,
  request: JsonRpcRequest,
  state: ProxyState,
): Promise<JsonRecord | null> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-token': token,
    'mcp-protocol-version': state.protocolVersion,
  };
  if (state.sessionId) {
    headers['mcp-session-id'] = state.sessionId;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), UPSTREAM_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      // The MCP token must never follow an attacker-controlled redirect to a
      // different host. Treat redirects as a protocol failure and report only
      // a generic reachability error to Claude.
      redirect: 'error',
      signal: abortController.signal,
    });
  } catch (error) {
    // The timer is only needed until fetch settles. Clear it on every
    // connection failure as well as on the normal response path; otherwise a
    // burst of unreachable MCP calls would retain one pending timer each for
    // the full deadline.
    clearTimeout(timeout);
    if (abortController.signal.aborted) {
      throw new Error('ThinkingData MCP upstream timed out.');
    }
    // Do not include the URL or fetch's low-level message: either can contain
    // operator-specific routing details, and a redirect error is intentionally
    // indistinguishable from another unreachable upstream at this boundary.
    throw new Error('ThinkingData MCP upstream is unreachable.');
  }

  try {
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId?.trim()) {
      state.sessionId = sessionId.trim();
    }
    let responseText: string;
    try {
      responseText = await readBoundedResponseText(response);
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error('ThinkingData MCP upstream timed out.');
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`ThinkingData MCP upstream returned HTTP ${response.status}.`);
    }
    return parseUpstreamResponse(responseText, request.id);
  } finally {
    // Keep the deadline active while the response body is being consumed, not
    // only while the TCP headers are being negotiated.
    clearTimeout(timeout);
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  upstreamUrl: string,
  token: string,
  state: ProxyState,
): Promise<void> {
  const method = readNonEmpty(request.method);
  if (!method) {
    writeError(request.id, 'MCP request method is required.');
    return;
  }

  // ThinkingData exposes a stateless JSON endpoint.  It accepts initialize,
  // tools/list and tools/call, but (unlike a stateful MCP transport) responds
  // with HTTP 500 when the client sends the standard initialized
  // notification.  Notifications do not have a response contract, so absorb
  // this one locally instead of forwarding a request that only creates noisy
  // upstream errors.  Other notifications are still forwarded for future
  // ThinkingData transports that may use them.
  if (method === 'notifications/initialized'
    && (request.id === undefined || request.id === null)) {
    return;
  }

  if (method === 'initialize') {
    const requestedVersion = readNonEmpty(request.params?.protocolVersion);
    if (requestedVersion) {
      state.protocolVersion = requestedVersion;
    }
  }

  const response = await forwardRequest(upstreamUrl, token, request, state);
  if (request.id === undefined || request.id === null || !response) {
    return;
  }

  if (method === 'tools/list' && isRecord(response.result)) {
    const tools = response.result.tools;
    if (Array.isArray(tools)) {
      response.result = {
        ...response.result,
        tools: sanitizeMcpToolSchemas(tools),
      };
    }
  }
  writeMessage(response);
}

async function runProxy(): Promise<void> {
  const upstreamUrl = readConfiguredUpstreamUrl();
  const token = readConfiguredToken();
  const state: ProxyState = {
    sessionId: null,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  for await (const line of input) {
    const raw = line.trim();
    if (!raw) {
      continue;
    }
    queue = queue.then(async () => {
      let request: JsonRpcRequest;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) {
          throw new Error('not an object');
        }
        request = parsed as JsonRpcRequest;
      } catch {
        writeError(null, 'MCP request must be valid JSON.');
        return;
      }

      try {
        await handleRequest(request, upstreamUrl, token, state);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'MCP request failed.';
        if (request.id !== undefined) {
          writeError(request.id, message);
        }
      }
    });
  }

  await queue;
}

// `process.argv[1]` may contain spaces or percent characters. Comparing a
// decoded, resolved filesystem path keeps the CLI entrypoint check correct in
// both the compiled bundle and source/dev launches.
const isEntrypoint = (() => {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(argvPath));
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  runProxy().catch((error) => {
    const message = error instanceof Error ? error.message : 'ThinkingData MCP proxy failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
