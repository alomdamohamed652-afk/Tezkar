import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { SessionUser } from "./auth.types.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  client: pg.PoolClient,
  user: SessionUser
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await client.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.userId, hashToken(token), expiresAt]
  );

  return { token, expiresAt };
}

export async function getSessionUser(
  client: pg.PoolClient,
  token: string
): Promise<SessionUser | null> {
  const result = await client.query(
    `SELECT
       u.id AS user_id,
       u.employee_id,
       u.username,
       COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS role_codes
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.is_active = TRUE
     GROUP BY u.id, u.employee_id, u.username`,
    [hashToken(token)]
  );

  const row = result.rows[0];
  if (!row) return null;

  await client.query(
    "UPDATE user_sessions SET last_seen_at = now() WHERE token_hash = $1",
    [hashToken(token)]
  );

  return {
    userId: row.user_id,
    employeeId: row.employee_id,
    username: row.username,
    roleCodes: row.role_codes ?? []
  };
}

export async function revokeSession(
  client: pg.PoolClient,
  token: string
): Promise<void> {
  await client.query(
    "UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token)]
  );
}
