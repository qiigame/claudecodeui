import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sessionShareLinksDb, sessionsDb } from '@/modules/database/index.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const DEFAULT_EXPIRY_HOURS = 7 * 24;
const MAX_EXPIRY_HOURS = 30 * 24;
const MAX_HISTORY_EVENTS = 500;
const MAX_MESSAGE_BYTES = 100 * 1024;
const MAX_SNAPSHOT_CONTENT_BYTES = 2 * 1024 * 1024;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type ShareSnapshotMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
};

type SessionShareSnapshot = {
  version: 1;
  title: string;
  provider: LLMProvider;
  projectName: string;
  createdAt: string | null;
  sharedAt: string;
  messages: ShareSnapshotMessage[];
  isTruncated: boolean;
};

type SnapshotSessionDetails = {
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  project: { displayName: string } | null;
};

type SnapshotHistory = {
  messages: NormalizedMessage[];
  hasMore: boolean;
};

type ActiveSessionShare = {
  shareId: string;
  expiresAt: string;
};

/**
 * Share rows reference the stable app-facing session id. Older URLs and
 * provider integrations may hand this service the provider-native id instead;
 * resolve it before querying or writing the foreign key, while preserving the
 * old "no row" behavior for an unknown id in the list endpoint.
 */
function resolveCanonicalSessionId(sessionId: string): string {
  const session =
    sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
  return session?.session_id ?? sessionId;
}

function utf8Prefix(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
    return { value, truncated: false };
  }

  const marker = '\n\n[Content truncated for public sharing]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maximumBytes <= markerBytes) {
    return { value: '', truncated: true };
  }

  const contentBudget = maximumBytes - markerBytes;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= contentBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return {
    value: `${value.slice(0, low).trimEnd()}${marker}`,
    truncated: true,
  };
}

function redactSensitiveText(input: string): string {
  return input
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|mcp[_-]?token|password|secret)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/([?&](?:access_token|api_key|token|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(?:\/Users|\/home)\/[^/\s]+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~');
}

/** Used by Session Share creation and its tests to copy only public-safe, displayable transcript fields. */
export function buildSessionShareSnapshot(
  details: SnapshotSessionDetails,
  history: SnapshotHistory,
  sharedAt: string,
): SessionShareSnapshot {
  const messages: ShareSnapshotMessage[] = [];
  let remainingBytes = MAX_SNAPSHOT_CONTENT_BYTES;
  let isTruncated = history.hasMore;

  for (const message of history.messages) {
    if (
      message.kind !== 'text'
      || (message.role !== 'user' && message.role !== 'assistant')
      || typeof message.content !== 'string'
      || message.isLocalCommand
      || message.isLocalCommandStdout
      || message.isCompactSummary
    ) {
      continue;
    }

    const redactedContent = redactSensitiveText(message.content).trim();
    if (!redactedContent) {
      continue;
    }

    const perMessage = utf8Prefix(redactedContent, MAX_MESSAGE_BYTES);
    const withinSnapshot = utf8Prefix(perMessage.value, remainingBytes);
    if (!withinSnapshot.value.trim()) {
      isTruncated = true;
      break;
    }

    messages.push({
      role: message.role,
      content: withinSnapshot.value,
      timestamp: message.timestamp,
    });
    remainingBytes -= Buffer.byteLength(withinSnapshot.value, 'utf8');
    isTruncated ||= perMessage.truncated || withinSnapshot.truncated;

    if (remainingBytes <= 0 || withinSnapshot.truncated) {
      isTruncated = true;
      break;
    }
  }

  return {
    version: 1,
    title: redactSensitiveText(details.summary.trim() || 'Shared conversation').slice(0, 240),
    provider: details.provider,
    projectName: redactSensitiveText(details.project?.displayName.trim() || 'Project').slice(0, 240),
    createdAt: details.createdAt,
    sharedAt,
    messages,
    isTruncated,
  };
}

function shareNotFound(): AppError {
  return new AppError('Shared conversation was not found.', {
    code: 'SHARE_NOT_FOUND',
    statusCode: 404,
  });
}

function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseStoredSnapshot(snapshotJson: string): SessionShareSnapshot {
  try {
    const parsed = JSON.parse(snapshotJson) as Partial<SessionShareSnapshot>;
    if (
      parsed.version !== 1
      || typeof parsed.title !== 'string'
      || typeof parsed.projectName !== 'string'
      || typeof parsed.sharedAt !== 'string'
      || !Array.isArray(parsed.messages)
    ) {
      throw new Error('Invalid snapshot');
    }
    return parsed as SessionShareSnapshot;
  } catch {
    throw shareNotFound();
  }
}

/** Used by Collaboration routes to create, revoke and resolve immutable session snapshots. */
export const sessionShareService = {
  async create(input: {
    sessionId: string;
    createdByUserId: number;
    expiresInHours?: number;
  }): Promise<{
    shareId: string;
    token: string;
    path: string;
    expiresAt: string;
  }> {
    const expiresInHours = input.expiresInHours ?? DEFAULT_EXPIRY_HOURS;
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > MAX_EXPIRY_HOURS) {
      throw new AppError(`expiresInHours must be an integer between 1 and ${MAX_EXPIRY_HOURS}.`, {
        code: 'INVALID_SHARE_EXPIRY',
        statusCode: 400,
      });
    }

    // Load Providers only when a share is actually created. Providers publishes
    // session changes through WebSocket, which in turn consumes Collaboration;
    // a static import here would make the feature barrels initialize cyclically.
    const { sessionsService } = await import('@/modules/providers/index.js');
    const details = sessionsService.getSessionDetailsById(input.sessionId);
    // Details resolves app/native aliases and returns the stable app id. Use
    // that id for both history and the share-link foreign key.
    const canonicalSessionId = details.sessionId;
    const history = await sessionsService.fetchHistory(canonicalSessionId, {
      limit: MAX_HISTORY_EVENTS,
      offset: 0,
    });
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + expiresInHours * 60 * 60 * 1000);
    const snapshot = buildSessionShareSnapshot(details, history, createdAt.toISOString());
    const token = randomBytes(32).toString('base64url');
    const shareId = randomUUID();

    sessionShareLinksDb.replaceForCreatorSession({
      id: shareId,
      sessionId: canonicalSessionId,
      tokenHash: hashShareToken(token),
      snapshotJson: JSON.stringify(snapshot),
      createdByUserId: input.createdByUserId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return {
      shareId,
      token,
      path: `/share/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  },

  listActiveForSession(input: {
    sessionId: string;
    createdByUserId: number;
  }): ActiveSessionShare[] {
    const row = sessionShareLinksDb.findActiveBySessionAndCreator(
      resolveCanonicalSessionId(input.sessionId),
      input.createdByUserId,
      new Date().toISOString(),
    );

    return row ? [{ shareId: row.id, expiresAt: row.expires_at }] : [];
  },

  revoke(shareId: string, createdByUserId: number): { shareId: string; revoked: true } {
    const revoked = sessionShareLinksDb.revoke(shareId, createdByUserId, new Date().toISOString());
    if (!revoked) {
      throw shareNotFound();
    }

    return { shareId, revoked: true };
  },

  getPublic(token: string): {
    expiresAt: string;
    snapshot: SessionShareSnapshot;
  } {
    if (!SHARE_TOKEN_PATTERN.test(token)) {
      throw shareNotFound();
    }

    const row = sessionShareLinksDb.findActiveByTokenHash(
      hashShareToken(token),
      new Date().toISOString(),
    );
    if (!row) {
      throw shareNotFound();
    }

    return {
      expiresAt: row.expires_at,
      snapshot: parseStoredSnapshot(row.snapshot_json),
    };
  },
};
