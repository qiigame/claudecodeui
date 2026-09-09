import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  createDeploymentPolicyMiddleware,
  parseDeploymentPolicy,
} from '@/modules/deployment-policy/index.js';
import type { VoiceService } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createVoiceRouter } from '../voice.routes.js';

function createService(calls: { transcribe: number; tts: number }): VoiceService {
  return {
    getHealth: () => ({ configured: true }),
    transcribe: async () => {
      calls.transcribe += 1;
      return { ok: true, value: { text: 'ok' } };
    },
    synthesizeSpeech: async () => {
      calls.tts += 1;
      return { ok: true, value: { contentType: 'audio/mpeg', body: null } };
    },
  };
}

async function withServer(
  policy: ReturnType<typeof parseDeploymentPolicy>,
  service: VoiceService,
  run: (baseUrl: string) => Promise<void>,
  parseAudioUpload: RequestHandler = (_request, _response, next) => next(),
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createDeploymentPolicyMiddleware({ policy }));
  app.use('/api/voice', createVoiceRouter({
    voiceService: service,
    parseAudioUpload,
    capabilityGuard: (operation) => createDeploymentPolicyMiddleware({ policy, capability: operation }),
  }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    response.status(appError?.statusCode ?? 500).json({ code: appError?.code ?? 'INTERNAL_ERROR' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('voice mutations are denied before upload/service when chat use is disabled', async () => {
  const calls = { transcribe: 0, tts: 0 };
  await withServer(
    parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
      CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'chat.use=false',
    }),
    createService(calls),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/voice/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
    },
  );
  assert.deepEqual(calls, { transcribe: 0, tts: 0 });
});

test('voice health remains readable while voice use is disabled', async () => {
  const calls = { transcribe: 0, tts: 0 };
  await withServer(
    parseDeploymentPolicy({
      CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
      CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'chat.use=false',
    }),
    createService(calls),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/voice/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { configured: true });
    },
  );
});

test('product/QA profile can use TTS through its chat capability', async () => {
  const calls = { transcribe: 0, tts: 0 };
  await withServer(
    parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' }),
    createService(calls),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/voice/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      assert.equal(response.status, 200);
    },
  );
  assert.deepEqual(calls, { transcribe: 0, tts: 1 });
});

test('production-style voice router ignores client provider overrides', async () => {
  const calls: Array<{ overrides?: unknown }> = [];
  const service: VoiceService = {
    getHealth: () => ({ configured: true }),
    transcribe: async (input) => {
      calls.push({ overrides: input.overrides });
      return { ok: true, value: { text: 'ok' } };
    },
    synthesizeSpeech: async (input) => {
      calls.push({ overrides: input.overrides });
      return { ok: true, value: { contentType: 'audio/mpeg', body: null } };
    },
  };
  const policy = parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' });
  await withServer(policy, service, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/voice/tts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-voice-api-key': 'attacker-key',
        'x-voice-tts-model': 'attacker-model',
      },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(calls, [{ overrides: {} }]);
});

test('standalone voice router captures a deployment policy source once', async () => {
  let sourceCalls = 0;
  let ttsCalls = 0;
  const policy = parseDeploymentPolicy({
    CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly',
    CLOUDCLI_DEPLOYMENT_CAPABILITIES: 'chat.use=false',
  });
  const router = createVoiceRouter({
    voiceService: {
      getHealth: () => ({ configured: true }),
      transcribe: async () => ({ ok: true, value: { text: 'unexpected' } }),
      synthesizeSpeech: async () => {
        ttsCalls += 1;
        return { ok: true, value: { contentType: 'audio/mpeg', body: null } };
      },
    },
    parseAudioUpload: (_request, _response, next) => next(),
    deploymentPolicy: () => {
      sourceCalls += 1;
      return policy;
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/voice', router);
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const typed = error as { statusCode?: number; code?: string };
    response.status(typed.statusCode ?? 500).json({ code: typed.code });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/voice/tts`;
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'must be denied' }),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_CAPABILITY_DENIED' });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  assert.equal(sourceCalls, 1);
  assert.equal(ttsCalls, 0);
});

test('voice upload parser errors are redacted before returning to the browser', async () => {
  const calls = { transcribe: 0, tts: 0 };
  await withServer(
    parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' }),
    createService(calls),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/voice/transcribe`, {
        method: 'POST',
        body: 'not-a-real-audio-upload',
      });
      assert.equal(response.status, 400);
      const payload = await response.json() as { error: string };
      assert.equal(payload.error, 'Audio upload failed.');
      assert.equal(payload.error.includes('/private/secret'), false);
    },
    (_request, _response, next) => {
      next(new Error('ENOENT: cannot open /private/secret/audio.tmp'));
    },
  );
  assert.deepEqual(calls, { transcribe: 0, tts: 0 });
});
