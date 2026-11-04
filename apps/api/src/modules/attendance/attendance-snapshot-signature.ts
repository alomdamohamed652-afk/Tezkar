import { createHmac, timingSafeEqual } from "node:crypto";
const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => JSON.stringify(key) + ":" + stableJson(object[key])).join(",") + "}";
}

function signatureFor(payload: Record<string, unknown>): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be configured before signing attendance snapshots.");
  return createHmac("sha256", secret).update(stableJson(payload)).digest("hex");
}

/** Sign the server-computed attendance row so payroll cannot trust edited browser values. */
export function signAttendanceSnapshot<T extends Record<string, unknown>>(row: T, issuedAt = Date.now()) {
  const payload = { ...row, snapshotIssuedAt: issuedAt };
  return { ...payload, snapshotSignature: signatureFor(payload) };
}

/** Reject client-edited or stale attendance rows before they can affect salary. */
export function verifyAttendanceSnapshot(row: Record<string, unknown>, now = Date.now()): boolean {
  const { snapshotSignature, ...payload } = row;
  const issuedAt = payload.snapshotIssuedAt;
  if (typeof snapshotSignature !== "string" || !/^[a-f0-9]{64}$/.test(snapshotSignature)) return false;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt)) return false;
  const age = now - issuedAt;
  if (age < -60_000 || age > SNAPSHOT_MAX_AGE_MS) return false;
  const expected = Buffer.from(signatureFor(payload), "hex");
  const supplied = Buffer.from(snapshotSignature, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
