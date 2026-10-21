import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { SessionUser } from "./auth.types.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

type SessionDevice = {
  deviceId?: string | null;
  deviceName?: string | null;
  deviceType?: string | null;
  browserName?: string | null;
  osName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function describeDevice(userAgent: string | null | undefined) {
  const ua = userAgent ?? "";
  const browserName = /Edg\//i.test(ua) ? "Microsoft Edge"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /OPR\//i.test(ua) ? "Opera"
    : /Chrome\//i.test(ua) ? "Google Chrome"
    : /Safari\//i.test(ua) && !/Chrome\//i.test(ua) ? "Safari" : "متصفح غير معروف";
  const osName = /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Linux/i.test(ua) ? "Linux" : "نظام غير معروف";
  const deviceType = /iPad|Tablet/i.test(ua) ? "tablet"
    : /Mobile|Android|iPhone|iPod/i.test(ua) ? "mobile" : "desktop";
  return { browserName, osName, deviceType };
}

export async function createSession(client: pg.PoolClient, user: SessionUser, device: SessionDevice = {}) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const inferred = describeDevice(device.userAgent);
  await client.query(
    `INSERT INTO user_sessions
       (user_id, token_hash, expires_at, device_id, device_name, device_type,
        browser_name, os_name, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [user.userId, hashToken(token), expiresAt, device.deviceId ?? null,
     device.deviceName ?? null, device.deviceType ?? inferred.deviceType,
     device.browserName ?? inferred.browserName, device.osName ?? inferred.osName,
     device.ipAddress ?? null, device.userAgent ?? null]
  );
  return { token, expiresAt };
}

export async function getSessionUser(client: pg.PoolClient, token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const result = await client.query(
    `SELECT u.id AS user_id, u.employee_id, u.username, e.full_name, u.is_bootstrap, u.must_complete_setup, u.must_change_password,
            COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS role_codes
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active = TRUE
     GROUP BY u.id, u.employee_id, u.username, e.full_name, u.is_bootstrap, u.must_complete_setup, u.must_change_password`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  await client.query("UPDATE user_sessions SET last_seen_at = now() WHERE token_hash = $1", [tokenHash]);
  return {
    userId: row.user_id,
    employeeId: row.employee_id,
    username: row.username,
    fullName: row.full_name ?? null,
    roleCodes: row.role_codes ?? [],
    isBootstrap: row.is_bootstrap,
    mustCompleteSetup: row.must_complete_setup,
    mustChangePassword: row.must_change_password
  };
}

export async function revokeSession(client: pg.PoolClient, token: string): Promise<void> {
  await client.query("UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)]);
}
