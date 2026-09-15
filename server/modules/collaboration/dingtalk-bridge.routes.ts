import crypto from 'node:crypto';
import fs from 'node:fs';

import express, { type Request, type Response } from 'express';

import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { parseDeploymentPolicy } from '@/modules/deployment-policy/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { collaborationService } from './collaboration.service.js';
import { identityRegistryService } from './identity-registry.service.js';

type BridgeRouteOptions = {
  runtime: ProviderRuntimeGateway;
  projectPath: string;
  provider?: LLMProvider;
  providerKey: string;
  namespace: string | readonly string[];
  tokenFile: string;
};

type BridgeTurnBody = {
  providerKey?: unknown;
  namespace?: unknown;
  subjectType?: unknown;
  senderId?: unknown;
  senderName?: unknown;
  conversationId?: unknown;
  messageId?: unknown;
  content?: unknown;
  sessionId?: unknown;
};

function readToken(file: string): Buffer {
  const stat = fs.lstatSync(file);
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o600
    || (typeof stat.nlink === 'number' && stat.nlink !== 1)
    || (uid !== null && typeof stat.uid === 'number' && stat.uid !== uid)) {
    throw new AppError('DingTalk bridge token file must be a regular 0600 file.', {
      code: 'DINGTALK_BRIDGE_TOKEN_INVALID', statusCode: 503,
    });
  }
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (!noFollow) throw new AppError('DingTalk bridge token cannot be opened safely.', {
    code: 'DINGTALK_BRIDGE_TOKEN_INVALID', statusCode: 503,
  });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  let token: Buffer;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || (opened.mode & 0o7777) !== 0o600
      || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('changed');
    }
    token = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (token.length < 16 || token.length > 4096) {
    throw new AppError('DingTalk bridge token is invalid.', {
      code: 'DINGTALK_BRIDGE_TOKEN_INVALID', statusCode: 503,
    });
  }
  return token.toString('utf8').trim() ? Buffer.from(token.toString('utf8').trim()) : Buffer.alloc(0);
}

function bearer(request: Request): Buffer {
  const raw = request.headers.authorization;
  if (typeof raw !== 'string' || !/^Bearer [^\s,]+$/.test(raw)) {
    throw new AppError('A bridge bearer token is required.', { code: 'DINGTALK_BRIDGE_TOKEN_REQUIRED', statusCode: 401 });
  }
  return Buffer.from(raw.slice(7));
}

function assertLoopback(request: Request): void {
  const address = request.socket.remoteAddress ?? '';
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    throw new AppError('The DingTalk bridge endpoint is local-only.', { code: 'DINGTALK_BRIDGE_LOOPBACK_REQUIRED', statusCode: 403 });
  }
}

function bodyString(body: BridgeTurnBody, key: keyof BridgeTurnBody, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AppError(`Bridge field ${String(key)} is invalid.`, { code: 'DINGTALK_BRIDGE_REQUEST_INVALID', statusCode: 400 });
  }
  return value.trim();
}

function extractAnswer(messages: Array<{ role?: string; content?: string; kind?: string }>): string {
  return messages.filter((message) => message.role === 'assistant' && typeof message.content === 'string')
    .map((message) => message.content?.trim() || '').filter(Boolean).pop() || '';
}

/** Local-only API consumed by didi-bridge; all actor resolution stays server-side. */
export function createDingTalkBridgeRoutes(options: BridgeRouteOptions): express.Router {
  const router = express.Router();
  const token = readToken(options.tokenFile);
  const provider = options.provider ?? 'codex';
  const completed = new Map<string, Record<string, unknown>>();
  const inflight = new Map<string, Promise<Record<string, unknown>>>();

  router.post('/turn', asyncHandler(async (request, response) => {
    assertLoopback(request);
    const supplied = bearer(request);
    if (supplied.length !== token.length || !crypto.timingSafeEqual(supplied, token)) {
      throw new AppError('The DingTalk bridge token is invalid.', { code: 'DINGTALK_BRIDGE_TOKEN_INVALID', statusCode: 401 });
    }
    const body = (request.body ?? {}) as BridgeTurnBody;
    const providerKey = bodyString(body, 'providerKey', 80);
    const namespace = bodyString(body, 'namespace', 160);
    const subjectType = bodyString(body, 'subjectType', 40) as 'open_dingtalk_id' | 'user_id' | 'union_id';
    if (!['open_dingtalk_id', 'user_id', 'union_id'].includes(subjectType)) {
      throw new AppError('Bridge subjectType is invalid.', { code: 'DINGTALK_BRIDGE_REQUEST_INVALID', statusCode: 400 });
    }
    const senderId = bodyString(body, 'senderId', 256);
    const conversationId = bodyString(body, 'conversationId', 256);
    const messageId = bodyString(body, 'messageId', 256);
    const content = bodyString(body, 'content', 20000);
    const allowedNamespaces = Array.isArray(options.namespace) ? options.namespace : [options.namespace];
    if (providerKey !== options.providerKey || !allowedNamespaces.includes(namespace)) {
      throw new AppError('Bridge provider or namespace is not allowed.', { code: 'DINGTALK_BRIDGE_SCOPE_DENIED', statusCode: 403 });
    }
    const requestKey = crypto.createHash('sha256')
      .update(`${providerKey}\0${namespace}\0${subjectType}\0${senderId}\0${conversationId}\0${messageId}`)
      .digest('hex');
    const previous = completed.get(requestKey);
    if (previous) {
      response.status(200).json(createApiSuccessResponse(previous));
      return;
    }
    const running = inflight.get(requestKey);
    if (running) {
      response.status(200).json(createApiSuccessResponse(await running));
      return;
    }
    const execute = async (): Promise<Record<string, unknown>> => {
    const identity = identityRegistryService.resolveDingTalkBridgeIdentity({
      providerKey, namespace, senderScope: subjectType, senderId,
      displayName: typeof body.senderName === 'string' ? body.senderName : undefined,
    }, { required: true });
    const actor = collaborationService.upsertDingTalkActor({
      source: 'dingtalk-bridge', providerKey, providerName: namespace,
      externalSubject: JSON.stringify({ providerKey, namespace, senderScope: subjectType, senderId }),
      subjectScope: 'provider', displayName: identity.displayName, badge: Array.from(identity.displayName)[0] || '?',
      personId: identity.personId, identityStatus: identity.identityStatus,
    });
    let sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : '';
    if (sessionId) {
      const attribution = collaborationService.getSessionAttribution(sessionId);
      if (!attribution || attribution.createdBy?.provider !== 'dingtalk-bridge'
        || attribution.createdBy?.userId !== actor.user.id
        || attribution.createdBy?.personId !== identity.personId) {
        sessionId = '';
      }
    }
    const [{ sessionsService }, { runDetachedChatTurn }] = await Promise.all([
      import('@/modules/providers/index.js'),
      import('@/modules/websocket/index.js'),
    ]);
    if (!sessionId) {
      const session = sessionsService.createAppSession(provider, options.projectPath, content);
      sessionId = session.sessionId;
      collaborationService.recordSessionCreated(sessionId, actor.user.id);
    }
    const result = await runDetachedChatTurn({ sessionId, userId: actor.user.id, content }, {
      runtime: options.runtime,
      // bridge is deliberately read-only; no filesystem mutation capability is supplied
      deploymentPolicy: parseDeploymentPolicy({ CLOUDCLI_DEPLOYMENT_PROFILE: 'product-qa-readonly' }),
      requireVerifiedDingTalkActor: false,
      isActorVerified: (userId) => {
        try { return collaborationService.getActorByUserId(userId)?.personId === identity.personId; } catch { return false; }
      },
    });
    if (!result.started) {
      return { status: 'failed', answer: '当前问答执行失败，请稍后重试。', sessionId, personId: identity.personId, identityStatus: identity.identityStatus };
    }
    const history = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 }, undefined);
    return { status: 'completed', answer: extractAnswer(history.messages), sessionId, personId: identity.personId, identityStatus: identity.identityStatus };
    };
    const promise = execute();
    inflight.set(requestKey, promise);
    try {
      const result = await promise;
      completed.set(requestKey, result);
      while (completed.size > 2048) completed.delete(completed.keys().next().value!);
      response.status(200).json(createApiSuccessResponse(result));
    } finally {
      inflight.delete(requestKey);
    }
  }));
  return router;
}
