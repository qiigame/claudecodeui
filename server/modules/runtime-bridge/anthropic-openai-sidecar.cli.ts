import { createAnthropicOpenAiBridgeServer } from './anthropic-openai-sidecar.service.js';

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

const host = process.env.COMIC_ANTHROPIC_BRIDGE_HOST?.trim() || '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('COMIC_ANTHROPIC_BRIDGE_HOST must be a loopback address.');
}

const port = readPositiveInteger(process.env.COMIC_ANTHROPIC_BRIDGE_PORT, 3092);
const server = createAnthropicOpenAiBridgeServer({
  upstreamBaseUrl: process.env.COMIC_ANTHROPIC_BRIDGE_UPSTREAM_BASE_URL,
  upstreamModel: process.env.COMIC_ANTHROPIC_BRIDGE_UPSTREAM_MODEL,
  reasoningEffort: process.env.COMIC_ANTHROPIC_BRIDGE_REASONING_EFFORT,
  maxBodyBytes: readPositiveInteger(
    process.env.COMIC_ANTHROPIC_BRIDGE_MAX_BODY_BYTES,
    50 * 1024 * 1024,
  ),
  upstreamTimeoutMs: readPositiveInteger(
    process.env.COMIC_ANTHROPIC_BRIDGE_UPSTREAM_TIMEOUT_MS,
    30 * 60 * 1000,
  ),
  forwardReasoning: readBoolean(
    process.env.COMIC_ANTHROPIC_BRIDGE_FORWARD_REASONING,
    true,
  ),
});

server.on('error', (error) => {
  const message = error instanceof Error ? error.message : 'Unknown server error';
  console.error(`[comic-anthropic-bridge] ${message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`[comic-anthropic-bridge] listening on http://${host}:${port}`);
});

const closeGracefully = () => {
  server.close(() => {
    process.exitCode = 0;
  });
};

process.once('SIGINT', closeGracefully);
process.once('SIGTERM', closeGracefully);
