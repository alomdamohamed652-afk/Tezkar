import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { AppError } from "../../http/errors.js";
import { findUserForLogin } from "./auth.repository.js";
import type { SessionUser } from "./auth.types.js";

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, salt, expectedHex] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export { hashPassword };

export async function authenticate(client: pg.PoolClient, username: string, password: string): Promise<SessionUser> {
  const user = await findUserForLogin(client, username);
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    throw new AppError("INVALID_CREDENTIALS", "اسم المستخدم أو كلمة المرور غير صحيحة", 401);
  }

  await client.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [user.id]);

  return {
    userId: user.id,
    employeeId: user.employee_id,
    username: user.username,
    roleCodes: user.role_codes ?? [],
    isBootstrap: user.is_bootstrap,
    mustCompleteSetup: user.must_complete_setup
  };
}
