import {
  collaborationRepository,
  type ActorWriteOptions,
} from './collaboration.repository.js';
import type { DingTalkActorIdentityInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const numericUserId = (value: string | number | null | undefined): number => {
  const userId = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Authenticated user is required for session attribution.', {
      code: 'COLLABORATION_USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
};

/**
 * Used by Auth, Providers, Projects, WebSocket, and Collaboration routes to
 * attach trusted people to otherwise globally shared sessions.
 */
export const collaborationService = {
  upsertDingTalkActor(input: DingTalkActorIdentityInput) {
    return collaborationRepository.upsertDingTalkActor(input);
  },

  getActorByUserId(userId: string | number | null | undefined) {
    return collaborationRepository.getActorByUserId(numericUserId(userId));
  },

  /** Used by the settings-admin enrollment view to resolve first-login subjects. */
  listPendingIdentityEnrollments() {
    return collaborationRepository.listPendingIdentityEnrollments();
  },

  assertActorCanWrite(
    userId: string | number | null | undefined,
    options: ActorWriteOptions = {},
  ) {
    return collaborationRepository.assertActorCanWrite(numericUserId(userId), options);
  },

  recordSessionCreated(sessionId: string, userId: string | number | null | undefined) {
    return collaborationRepository.recordSessionAction(sessionId, numericUserId(userId), 'create');
  },

  recordSessionAction(
    sessionId: string,
    userId: string | number | null | undefined,
    action: 'send' | 'edit_send' | 'fork' | 'rename' | 'restore' | 'archive',
  ) {
    return collaborationRepository.recordSessionAction(sessionId, numericUserId(userId), action);
  },

  getSessionAttribution(sessionId: string) {
    return collaborationRepository.getSessionAttribution(sessionId);
  },

  getSessionAttributions(sessionIds: readonly string[]) {
    return collaborationRepository.getSessionAttributions(sessionIds);
  },

  listSessionEvents(sessionId: string, limit = 100) {
    return collaborationRepository.listSessionEvents(sessionId, Math.min(Math.max(limit, 1), 500));
  },
};
