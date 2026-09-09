import { getConnection } from '@/modules/database/connection.js';

type SessionShareLinkRow = {
  id: string;
  session_id: string;
  token_hash: string;
  snapshot_json: string;
  created_by_user_id: number | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type ActiveCreatorSessionShareRow = Pick<
  SessionShareLinkRow,
  'id' | 'session_id' | 'created_by_user_id' | 'created_at' | 'expires_at'
>;

type ReplaceSessionShareLinkInput = {
  id: string;
  sessionId: string;
  tokenHash: string;
  snapshotJson: string;
  createdByUserId: number;
  createdAt: string;
  expiresAt: string;
};

/** Used by Collaboration to persist and resolve revocable public snapshot links. */
export const sessionShareLinksDb = {
  replaceForCreatorSession(input: ReplaceSessionShareLinkInput): void {
    getConnection().prepare(`
      INSERT INTO session_share_links (
        id,
        session_id,
        token_hash,
        snapshot_json,
        created_by_user_id,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, created_by_user_id) DO UPDATE SET
        id = excluded.id,
        token_hash = excluded.token_hash,
        snapshot_json = excluded.snapshot_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        revoked_at = NULL
    `).run(
      input.id,
      input.sessionId,
      input.tokenHash,
      input.snapshotJson,
      input.createdByUserId,
      input.createdAt,
      input.expiresAt,
    );
  },

  findActiveBySessionAndCreator(
    sessionId: string,
    createdByUserId: number,
    now: string,
  ): ActiveCreatorSessionShareRow | null {
    const row = getConnection().prepare(`
      SELECT
        id,
        session_id,
        created_by_user_id,
        created_at,
        expires_at
      FROM session_share_links
      WHERE session_id = ?
        AND created_by_user_id = ?
        AND revoked_at IS NULL
        AND datetime(expires_at) > datetime(?)
      LIMIT 1
    `).get(sessionId, createdByUserId, now) as ActiveCreatorSessionShareRow | undefined;

    return row ?? null;
  },

  findActiveByTokenHash(tokenHash: string, now: string): SessionShareLinkRow | null {
    const row = getConnection().prepare(`
      SELECT
        id,
        session_id,
        token_hash,
        snapshot_json,
        created_by_user_id,
        created_at,
        expires_at,
        revoked_at
      FROM session_share_links
      WHERE token_hash = ?
        AND revoked_at IS NULL
        AND datetime(expires_at) > datetime(?)
      LIMIT 1
    `).get(tokenHash, now) as SessionShareLinkRow | undefined;

    return row ?? null;
  },

  revoke(id: string, createdByUserId: number, revokedAt: string): boolean {
    const result = getConnection().prepare(`
      UPDATE session_share_links
      SET revoked_at = ?
      WHERE id = ?
        AND created_by_user_id = ?
        AND revoked_at IS NULL
    `).run(revokedAt, id, createdByUserId);

    return result.changes === 1;
  },
};
