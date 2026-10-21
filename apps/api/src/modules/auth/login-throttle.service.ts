import { createHash } from "node:crypto";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
let lastPrunedAt = 0;

function keyFor(ip: string, username: string) {
  return createHash("sha256").update(ip + ":" + username.trim().toLowerCase()).digest("hex");
}

export async function assertPersistentLoginAllowed(ip: string, username: string): Promise<void> {
  if (Date.now() - lastPrunedAt > 60 * 60 * 1000) {
    await prunePersistentLoginFailures();
    lastPrunedAt = Date.now();
  }
  const keys = [keyFor(ip, username), keyFor(ip, "__ip__")];
  const result = await pool.query(
    "SELECT blocked_until FROM auth_login_attempts WHERE attempt_key = ANY($1::text[])",
    [keys]
  );
  const now = Date.now();
  if (result.rows.some((row) => row.blocked_until && new Date(row.blocked_until).getTime() > now)) {
    throw new AppError("LOGIN_RATE_LIMITED", "محاولات تسجيل الدخول كثيرة. حاول مرة أخرى بعد 15 دقيقة.", 429);
  }
}

async function upsertFailure(ip: string, username: string, maxFailures: number): Promise<void> {
  await pool.query(
    "INSERT INTO auth_login_attempts (attempt_key, username_key, ip_address, failure_count, window_started_at, blocked_until, updated_at) VALUES ($1,$2,$3,1,now(),NULL,now()) ON CONFLICT (attempt_key) DO UPDATE SET failure_count = CASE WHEN auth_login_attempts.window_started_at <= now() - interval '15 minutes' THEN 1 ELSE auth_login_attempts.failure_count + 1 END, window_started_at = CASE WHEN auth_login_attempts.window_started_at <= now() - interval '15 minutes' THEN now() ELSE auth_login_attempts.window_started_at END, blocked_until = CASE WHEN (CASE WHEN auth_login_attempts.window_started_at <= now() - interval '15 minutes' THEN 1 ELSE auth_login_attempts.failure_count + 1 END) >= $4 THEN now() + interval '15 minutes' ELSE NULL END, ip_address = EXCLUDED.ip_address, updated_at = now()",
    [keyFor(ip, username), username, ip, maxFailures]
  );
}

export async function recordPersistentLoginFailure(ip: string, username: string): Promise<void> {
  await upsertFailure(ip, username.trim().toLowerCase(), MAX_FAILURES);
  await upsertFailure(ip, "__ip__", 30);
}

export async function clearPersistentLoginFailures(ip: string, username: string): Promise<void> {
  await pool.query("DELETE FROM auth_login_attempts WHERE attempt_key = $1", [keyFor(ip, username)]);
}

export async function prunePersistentLoginFailures(): Promise<void> {
  await pool.query("DELETE FROM auth_login_attempts WHERE updated_at < now() - interval '2 days'");
}

export const loginRateLimitWindowMs = WINDOW_MS;
