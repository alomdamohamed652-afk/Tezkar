import test from "node:test";
import assert from "node:assert/strict";
import { createBackupArchive, createBackupArchiveStream, readBackupArchive, type BackupPayload } from "../src/modules/backup/backup-archive.js";

const payload: BackupPayload = {
  format: "tezkar-full-backup",
  version: 1,
  createdAt: "2026-11-17T00:00:00.000Z",
  sourceSchemaVersion: "test-schema",
  sequences: [{ name: "employee_code_seq", lastValue: "42", isCalled: true, incrementBy: "1", minValue: "1", maxValue: "2147483647", startValue: "1", cacheSize: "1", cycle: false }, { name: "user_code_seq", lastValue: "7", isCalled: false, incrementBy: "1", minValue: "1", maxValue: "2147483647", startValue: "1", cacheSize: "1", cycle: false }],
  tables: [{ name: "employees", primaryKey: ["id"], columns: [{ name: "id", pgType: "uuid" }, { name: "full_name", pgType: "text" }, { name: "amount", pgType: "numeric(12,2)" }, { name: "at", pgType: "timestamp with time zone" }], rows: [{ id: "1", full_name: "عامل تجريبي", amount: "125.50", at: "2026-11-17 01:02:03.123456+00" }] }]
};

test("backup archive encrypts and round-trips payload without changing text or decimal strings", async () => {
  const archive = await createBackupArchive(payload, "a-strong-backup-password");
  assert.notEqual(archive.toString("utf8").includes("عامل تجريبي"), true);
  assert.deepEqual(await readBackupArchive(archive, "a-strong-backup-password"), payload);
});

test("backup archive preserves sequence state exactly", async () => {
  const archive = await createBackupArchive(payload, "a-strong-backup-password");
  const restored = await readBackupArchive(archive, "a-strong-backup-password");
  assert.deepEqual(restored.sequences, payload.sequences);
});

test("backup archive rejects incorrect password and tampering", async () => {
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


test("streaming archive v2 encrypts incremental JSON chunks and round-trips", async () => {
  async function* plaintextChunks() {
    const json = JSON.stringify(payload);
    for (let offset = 0; offset < json.length; offset += 37) {
      yield json.slice(offset, offset + 37);
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of createBackupArchiveStream(plaintextChunks(), "a-strong-backup-password")) {
    chunks.push(Buffer.from(chunk));
  }
  const archive = Buffer.concat(chunks);
  assert.equal(archive.subarray(0, 8).toString("utf8"), "TZKBACK1");
  const headerLength = archive.readUInt16BE(8);
  const header = JSON.parse(archive.subarray(10, 10 + headerLength).toString("utf8"));
  assert.equal(header.version, 2);
  assert.deepEqual(await readBackupArchive(archive, "a-strong-backup-password"), payload);
});

test("streaming archive v2 rejects tampering in the final authentication tag", async () => {
  async function* plaintextChunks() {
    yield JSON.stringify(payload);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of createBackupArchiveStream(plaintextChunks(), "a-strong-backup-password")) {
    chunks.push(Buffer.from(chunk));
  }
  const damaged = Buffer.concat(chunks);
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(() => readBackupArchive(damaged, "a-strong-backup-password"), /كلمة المرور غير صحيحة/);
});

test("legacy archive v1 remains readable after adding streaming archive v2", async () => {
  const legacy = await createBackupArchive(payload, "a-strong-backup-password");
  const headerLength = legacy.readUInt16BE(8);
  const header = JSON.parse(legacy.subarray(10, 10 + headerLength).toString("utf8"));
  assert.equal(header.version, 1);
  assert.deepEqual(await readBackupArchive(legacy, "a-strong-backup-password"), payload);
});
