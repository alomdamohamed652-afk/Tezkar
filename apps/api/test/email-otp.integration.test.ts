import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { maskEmail, fakeMask, hashCode, normalizePhoneDigits, safeEqualText } from "../src/modules/auth/email-otp.service.js";

test("normalizePhoneDigits keeps the last 10 digits", () => {
  assert.equal(normalizePhoneDigits("+2010 1234 5678"), "1012345678");
  assert.equal(normalizePhoneDigits("01012345678"), "01012345678".slice(-10));
  assert.equal(normalizePhoneDigits("12345"), "");
});

test("maskEmail shows at most two local chars and one domain char", () => {
  assert.equal(maskEmail("tezkar@tezka.com"), "te****@t***.com");
  assert.equal(maskEmail("a@b.co"), "a****@b***.co");
  assert.equal(maskEmail("worker.name@gmail.com"), "wo****@g***.com");
});

test("fakeMask is deterministic, plausible and differs across phones", () => {
  const a1 = fakeMask("1012345678");
  const a2 = fakeMask("1012345678");
  const b = fakeMask("1155556666");
  assert.equal(a1, a2);
  assert.match(a1, /^[a-z]{2}\*\*\*\*@[a-z]\*\*\*\.com$/);
  assert.notEqual(a1, b);
});

test("hashCode and safeEqualText behave", () => {
  const h1 = hashCode("user-1", "PASSWORD_RESET", "123456");
  const h2 = hashCode("user-1", "PASSWORD_RESET", "123456");
  const h3 = hashCode("user-1", "PASSWORD_RESET", "654321");
  const h4 = hashCode("user-2", "PASSWORD_RESET", "123456");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.notEqual(h1, h4);
  assert.ok(safeEqualText(h1, h2));
  assert.ok(!safeEqualText(h1, h3));
});

test("password_reset_otps migration applies and enforces one unique email", {
  skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL not set"
}, async () => {
  const { default: pg } = await import("pg");
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const adminUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(adminUrl.hostname.toLowerCase()), "test DB must be local");
  assert.equal(adminUrl.pathname.slice(1), "postgres", "admin connection must target the disposable postgres database");

  const name = "tezkar_email_otp_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const target = new URL(process.env.TEST_DATABASE_URL!);
  target.pathname = "/" + name;
  const db = new pg.Client({ connectionString: target.toString() });
  await db.connect();
  try {
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
    await db.query(readFileSync(path.join(migrationsDir, "001_foundation.sql"), "utf8"));
    await db.query(readFileSync(path.join(migrationsDir, "2026112404_email_otp_password_reset.sql"), "utf8"));

    const u1 = await db.query("INSERT INTO users (username, password_hash) VALUES ('u1', 'x') RETURNING id");
    const u2 = await db.query("INSERT INTO users (username, password_hash) VALUES ('u2', 'x') RETURNING id");

    await db.query("UPDATE users SET email='A@B.com', email_verified_at=now() WHERE id=$1", [u1.rows[0].id]);
    await assert.rejects(
      db.query("UPDATE users SET email='a@b.com' WHERE id=$1", [u2.rows[0].id]),
      /duplicate key/,
      "case-insensitive email uniqueness"
    );

    // OTP lifecycle: insert, expire-check, attempt counting, consumption.
    await db.query(
      "INSERT INTO password_reset_otps (user_id, purpose, code_hash, expires_at) VALUES ($1,'PASSWORD_RESET','hash-1', now() + interval '10 minutes')",
      [u1.rows[0].id]
    );
    const active = await db.query("SELECT id FROM password_reset_otps WHERE user_id=$1 AND consumed_at IS NULL AND expires_at > now()", [u1.rows[0].id]);
    assert.equal(active.rowCount, 1);
    await db.query("UPDATE password_reset_otps SET attempts=attempts+1 WHERE id=$1", [active.rows[0].id]);
    await db.query("UPDATE password_reset_otps SET consumed_at=now() WHERE id=$1", [active.rows[0].id]);
    const after = await db.query("SELECT consumed_at, attempts FROM password_reset_otps WHERE id=$1", [active.rows[0].id]);
    assert.equal(after.rows[0].attempts, 1);
    assert.ok(after.rows[0].consumed_at);
  } finally {
    await db.end();
    const admin2 = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin2.connect();
    try {
      await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin2.end();
    }
  }
});
