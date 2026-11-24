import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { buildOtpEmail } from "./email-otp.template.js";

export type OtpPurpose = "EMAIL_VERIFY" | "PASSWORD_RESET";

const OTP_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;

function pepper(): string {
  // SESSION_SECRET is required by config validation (min 32 chars), so it is
  // always present in production; the fallback only protects bare test runs.
  return process.env.SESSION_SECRET ?? "tezkar-otp-dev-secret";
}

export function normalizePhoneDigits(input: string): string {
  const digits = input.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const [name = "", ...rest] = domain.split(".");
  const tld = rest.join(".");
  return `${local.slice(0, 2)}****@${name.slice(0, 1)}***${tld ? "." + tld : ""}`;
}

// Deterministic plausible-looking mask for unknown phones or accounts without a
// verified email, so the response never reveals whether the phone has an account.
export function fakeMask(phoneDigits: string): string {
  const h = createHmac("sha256", pepper()).update("mask:" + phoneDigits).digest("hex");
  const letters = "abcdefghjkmnpqrstuvwxyz";
  const pick = (i: number) => letters[parseInt(h[i] ?? "0", 16) % letters.length] ?? "a";
  return `${pick(0)}${pick(1)}****@${pick(2)}***.com`;
}

export function hashCode(userId: string, purpose: OtpPurpose, code: string): string {
  return createHmac("sha256", pepper()).update(`otp:${userId}:${purpose}:${code}`).digest("hex");
}

export function safeEqualText(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function generateCode(): string {
  return randomInt(0, 1000000).toString().padStart(6, "0");
}

export async function createOtp(
  client: pg.PoolClient,
  userId: string,
  purpose: OtpPurpose,
  ip: string | null,
  userAgent: string | null
): Promise<string> {
  const code = generateCode();
  await client.query(
    "UPDATE password_reset_otps SET consumed_at=now() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL",
    [userId, purpose]
  );
  await client.query(
    `INSERT INTO password_reset_otps (user_id, purpose, code_hash, expires_at, created_ip, created_user_agent)
     VALUES ($1,$2,$3, now() + interval '10 minutes', $4, $5)`,
    [userId, purpose, hashCode(userId, purpose, code), ip, userAgent]
  );
  return code;
}

export async function verifyOtp(
  client: pg.PoolClient,
  userId: string,
  purpose: OtpPurpose,
  code: string
): Promise<boolean> {
  const r = await client.query(
    `SELECT id, code_hash, attempts FROM password_reset_otps
     WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [userId, purpose]
  );
  const row = r.rows[0];
  if (!row) return false;
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await client.query("UPDATE password_reset_otps SET consumed_at=now() WHERE id=$1", [row.id]);
    return false;
  }
  const expected = hashCode(userId, purpose, code);
  if (!safeEqualText(expected, row.code_hash)) {
    const attempts = row.attempts + 1;
    await client.query(
      "UPDATE password_reset_otps SET attempts=$1, consumed_at=CASE WHEN $1 >= $2 THEN now() ELSE NULL END WHERE id=$3",
      [attempts, MAX_CODE_ATTEMPTS, row.id]
    );
    return false;
  }
  await client.query("UPDATE password_reset_otps SET consumed_at=now() WHERE id=$1", [row.id]);
  return true;
}

export async function consumeActiveOtps(client: pg.PoolClient, userId: string, purpose: OtpPurpose): Promise<void> {
  await client.query(
    "UPDATE password_reset_otps SET consumed_at=now() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL",
    [userId, purpose]
  );
}

// Fixed-window rate limiting on the shared auth_login_attempts table, keyed by
// a scope prefix so login throttling and OTP throttling never collide.
export async function assertOtpRateAllowed(
  scope: string,
  id: string,
  maxAttempts: number,
  windowMinutes: number,
  blockMinutes: number,
  errorMessage: string
): Promise<void> {
  const key = createHash("sha256").update(`otp-rate:${scope}:${id.trim().toLowerCase()}`).digest("hex");
  const r = await pool.query(
    `INSERT INTO auth_login_attempts (attempt_key, username_key, ip_address, failure_count, window_started_at, blocked_until, updated_at)
     VALUES ($1,$2,'',1,now(),NULL,now())
     ON CONFLICT (attempt_key) DO UPDATE SET
       failure_count = CASE WHEN auth_login_attempts.window_started_at <= now() - ($3 || ' minutes')::interval THEN 1 ELSE auth_login_attempts.failure_count + 1 END,
       window_started_at = CASE WHEN auth_login_attempts.window_started_at <= now() - ($3 || ' minutes')::interval THEN now() ELSE auth_login_attempts.window_started_at END,
       blocked_until = CASE
         WHEN (CASE WHEN auth_login_attempts.window_started_at <= now() - ($3 || ' minutes')::interval THEN 1 ELSE auth_login_attempts.failure_count + 1 END) > $4
         THEN now() + ($5 || ' minutes')::interval
         ELSE auth_login_attempts.blocked_until END,
       updated_at = now()
     RETURNING blocked_until`,
    [key, `${scope}:${id.slice(0, 40)}`, String(windowMinutes), maxAttempts, String(blockMinutes)]
  );
  const blockedUntil = r.rows[0]?.blocked_until;
  if (blockedUntil && new Date(blockedUntil).getTime() > Date.now()) {
    throw new AppError("OTP_RATE_LIMITED", errorMessage, 429);
  }
}

type SendResult = { ok: true } | { ok: false; reason: string };

// Sends the OTP through Brevo's HTTPS API (no extra dependencies). Fails closed:
// when the env vars are missing nothing is sent and the caller keeps its generic
// response; the reason is only ever written to the server log.
export async function sendOtpEmail(to: string, code: string, purpose: OtpPurpose): Promise<SendResult> {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME ?? "تذكار";
  if (!apiKey || !senderEmail) {
    console.error("[email-otp] BREVO_API_KEY or BREVO_SENDER_EMAIL missing; OTP email not sent.");
    return { ok: false, reason: "missing_config" };
  }
  const { subject, html, text } = buildOtpEmail(purpose, code, OTP_TTL_MINUTES);
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { email: senderEmail, name: senderName }, to: [{ email: to }], subject, textContent: text, htmlContent: html })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[email-otp] Brevo send failed: HTTP ${res.status} ${body.slice(0, 300)}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("[email-otp] Brevo send error", err);
    return { ok: false, reason: "network" };
  }
}
