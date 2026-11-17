import test from "node:test";
import assert from "node:assert/strict";
import { createBackupArchive, readBackupArchive, type BackupPayload } from "../src/modules/backup/backup-archive.js";

const payload: BackupPayload = {
  format: "tezkar-full-backup",
  version: 1,
  createdAt: "2026-11-17T00:00:00.000Z",
  sourceSchemaVersion: "test-schema",
  sequences: [{ name: "employee_code_seq", lastValue: "42", isCalled: true }, { name: "user_code_seq", lastValue: "7", isCalled: false }],
  tables: [{ name: "employees", primaryKey: ["id"], columns: [{ name: "id", pgType: "uuid" }, { name: "full_name", pgType: "text" }, { name: "amount", pgType: "numeric(12,2)" }, { name: "at", pgType: "timestamp with time zone" }], rows: [{ id: "1", full_name: "عامل تجريبي", amount: "125.50", at: "2026-11-17 01:02:03.123456+00" }] }]
};

test("backup archive encrypts and round-trips payload without changing text or decimal strings", async () => {
  const archive = await createBackupArchive(payload, "a-strong-backup-password");
  assert.notEqual(archive.toString("utf8").includes("عامل تجريبي"), true);
  assert.deepEqual(await readBackupArchive(archive, "a-strong-backup-password"), payload);
});

test("backup archive preserves sequence state exactly", async () => {\n  const archive = await createBackupArchive(payload, "a-strong-backup-password");\n  const restored = await readBackupArchive(archive, "a-strong-backup-password");\n  assert.deepEqual(restored.sequences, payload.sequences);\n});\n\ntest("backup archive rejects incorrect password and tampering", async () => {
  const archive = await createBackupArchive(payload, "a-strong-backup-password");
  await assert.rejects(() => readBackupArchive(archive, "another-strong-password"), /كلمة المرور غير صحيحة/);
  const damaged = Buffer.from(archive);
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(() => readBackupArchive(damaged, "a-strong-backup-password"), /كلمة المرور غير صحيحة/);
});

test("backup archive rejects weak passwords and unsupported data", async () => {
  await assert.rejects(() => createBackupArchive(payload, "short"), /12 إلى 200/);
  const archive = await createBackupArchive(payload, "a-strong-backup-password");
  await assert.rejects(() => readBackupArchive(archive.subarray(0, 20), "a-strong-backup-password"));
});
