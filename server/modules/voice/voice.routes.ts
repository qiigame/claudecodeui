import { Readable } from 'node:stream';

import express from 'express';

import {
  captureDeploymentPolicy,
  createDeploymentPolicyGuard,
  type DeploymentPolicySource,
} from '@/modules/deployment-policy/index.js';
import type { VoiceRequestOverrides, VoiceService, VoiceServiceResult } from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  parseAudioUpload: express.RequestHandler;
  /** Optional deployment capability guard supplied by the composition root. */
  capabilityGuard?: (operation: string) => express.RequestHandler;
  /**
   * Startup deployment policy used by standalone/alternate mounts when no
   * capability factory is supplied. A function source is evaluated exactly
   * once while constructing the router, never once per request.
   */
  deploymentPolicy?: DeploymentPolicySource;
  /**
   * Allows request headers to select provider overrides. Production mounts
   * keep this false so callers cannot replace the server-owned API key or
   * consume an operator-selected backend/model quota.
   */
  allowRequestOverrides?: boolean;
};

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const trimmedValue = normalizedValue?.trim();
  return trimmedValue || undefined;
}

function parseVoiceOverrides(
  request: express.Request,
  allowRequestOverrides: boolean,
): VoiceRequestOverrides {
  if (!allowRequestOverrides) {
    return {};
  }
  return {
    apiKey: readHeaderValue(request.headers['x-voice-api-key']),
    sttModel: readHeaderValue(request.headers['x-voice-stt-model']),
    ttsModel: readHeaderValue(request.headers['x-voice-tts-model']),
    ttsVoice: readHeaderValue(request.headers['x-voice-tts-voice']),
    ttsFormat: readHeaderValue(request.headers['x-voice-tts-format']),
  };
}

/**
 * Keeps multipart parser diagnostics out of the HTTP response. Multer and
 * storage adapters may include temporary filenames, local paths, or provider
 * configuration details in an error message; those details belong in server
 * logs only. Known parser codes retain a useful, stable client hint.
 */
function audioUploadErrorMessage(error: unknown): string {
  const errorCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (errorCode === 'LIMIT_FILE_SIZE') return 'Audio file is too large.';
  if (errorCode === 'LIMIT_UNEXPECTED_FILE') return 'Unexpected audio field.';
  if (errorCode === 'LIMIT_FILE_COUNT' || errorCode === 'LIMIT_PART_COUNT') {
    return 'Audio upload contains too many parts.';
  }
  return 'Audio upload failed.';
}

function sendAudioUploadFailure(response: express.Response, error: unknown): void {
  response.status(400).json({ error: audioUploadErrorMessage(error) });
}

function sendFailure<TValue>(
  response: express.Response,
  result: VoiceServiceResult<TValue>,
): result is Extract<VoiceServiceResult<TValue>, { ok: false }> {
  if (result.ok) {
    return false;
  }

  response.status(result.status).json({ error: result.error });
  return true;
}

/**
 * Creates the transport-only router used by the Voice composition root. It is
 * exported for Voice route tests; other modules consume only the composed
 * router exposed from the Voice barrel.
 */
export function createVoiceRouter(dependencies: VoiceRouterDependencies): express.Router {
  const router = express.Router();
  // Voice calls leave the installation and can consume paid provider quota.
  // Keep the boundary explicit even though they do not mutate a repository.
  // `chat.use` is intentionally shared with the product/QA chat capability;
  // a future profile can split this into a dedicated `voice.use` capability.
  const startupPolicy = dependencies.capabilityGuard
    ? undefined
    : captureDeploymentPolicy(dependencies.deploymentPolicy);
  const voiceUseGuard = dependencies.capabilityGuard
    ? dependencies.capabilityGuard('chat.use')
    : createDeploymentPolicyGuard({
      // Capture the trusted process policy when an alternate host omits the
      // composition-root resolver; do not re-read mutable env on each call.
      policy: startupPolicy!,
      capability: 'chat.use',
    });
  // A production factory may explicitly opt into request overrides for a
  // writable developer deployment. Bare/alternate mounts default to locked
  // server-owned credentials and models.
  // Provider credentials/models are deployment-owned in production. Request
  // headers are accepted only when a writable developer composition opts in
  // explicitly; a bare/alternate mount must default to the safe behavior.
  const allowRequestOverrides = dependencies.allowRequestOverrides ?? false;

  router.get('/health', (_request, response) => {
    response.json(dependencies.voiceService.getHealth());
  });

  router.post('/transcribe', voiceUseGuard, (request, response, next) => {
    try {
      dependencies.parseAudioUpload(request, response, (uploadError?: unknown) => {
        if (uploadError) {
          sendAudioUploadFailure(response, uploadError);
          return;
        }

        // Multer uses a callback API, so bridge its parsed request into the async
        // service call and forward unexpected rejections to Express middleware.
        void (async () => {
          if (!request.file) {
            response.status(400).json({ error: 'No audio uploaded' });
            return;
          }

          const result = await dependencies.voiceService.transcribe({
            audio: {
              bytes: request.file.buffer,
              mimeType: request.file.mimetype || 'audio/webm',
              fileName: request.file.originalname || 'recording.webm',
            },
            overrides: parseVoiceOverrides(request, allowRequestOverrides),
          });

          if (sendFailure(response, result)) {
            return;
          }

          response.json(result.value);
        })().catch(next);
      });
    } catch (error) {
      // A custom parser adapter can throw before invoking its callback. Keep
      // that synchronous path under the same redacted upload contract.
      sendAudioUploadFailure(response, error);
    }
  });

  router.post('/tts', voiceUseGuard, asyncHandler(async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      response.status(400).json({ error: 'text required' });
      return;
    }

    const result = await dependencies.voiceService.synthesizeSpeech({
      text,
      overrides: parseVoiceOverrides(request, allowRequestOverrides),
    });
    if (sendFailure(response, result)) {
      return;
    }

    response.setHeader('Content-Type', result.value.contentType);
    response.setHeader('Cache-Control', 'no-store');
    if (!result.value.body) {
      response.end();
      return;
    }

    // `Response.body` is typed with the DOM stream interface, while Node's
    // `Readable.fromWeb` expects the structurally-compatible `node:stream/web`
    // variant.  The runtime value is the undici/Node web stream returned by
    // the server-side fetch adapter; keep the conversion explicit so the
    // NodeNext compiler does not reject the two lib declarations' iterator
    // differences.
    Readable.fromWeb(
      result.value.body as unknown as import('node:stream/web').ReadableStream,
    ).on('error', (error) => response.destroy(error)).pipe(response);
  }));

  return router;
}
