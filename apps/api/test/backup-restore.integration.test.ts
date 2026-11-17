import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { BackupPayload } from "../src/modules/backup/backup-archive.js";
import { restoreBackupIntoCurrentDatabase } from "../src/modules/backup/backup-restore.service.js";

const adminUrl = process.env.TEST_DATABASE_URL;

function assertDisposableDatabaseUrl(value: string): void {
  const url = new URL(value);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "backup restore integration tests require a local disposable PostgreSQL server");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must connect to the postgres admin database, never an application database");
}

test("backup restore is additive, idempotent, FK ordered, transactional and sequence-monotonic", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);

  const databaseName = "tezkar_backup_restore_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = "/" + databaseName;
  const pool = new pg.Pool({ connectionString: targetUrl.toString() });
  const parentId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const extraId = "33333333-3333-4333-8333-333333333333";
  const additionalChildRows = Array.from({ length: 100 }, (_, index) => ({
    id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
    parent_id: parentId,
    label: `child-${index + 1}`
  }));
  const payload: BackupPayload = {
    format: "tezkar-full-backup",
    version: 1,
    createdAt: "2026-11-17T00:00:00.000Z",
    sourceSchemaVersion: "integration-test",
    tables: [
      {
        name: "backup_it_children",
        primaryKey: ["id"],
        columns: [{ name: "id", pgType: "uuid" }, { name: "parent_id", pgType: "uuid" }, { name: "label", pgType: "text" }],
        rows: [{ id: childId, parent_id: parentId, label: "child" }, ...additionalChildRows]
      },
      {
        name: "backup_it_parents",
        primaryKey: ["id"],
        columns: [{ name: "id", pgType: "uuid" }, { name: "child_id", pgType: "uuid" }, { name: "label", pgType: "text" }],
        rows: [{ id: parentId, child_id: childId, label: "parent" }]
      }
    ],
    sequences: [{ name: "backup_it_seq", lastValue: "20", isCalled: true, incrementBy: "1", minValue: "1", maxValue: "9223372036854775807", startValue: "1", cacheSize: "1", cycle: false }]
  };

  try {
    await pool.query("CREATE TABLE backup_it_parents(id uuid PRIMARY KEY, child_id uuid, label text NOT NULL)");
    await pool.query("CREATE TABLE backup_it_children(id uuid PRIMARY KEY, parent_id uuid NOT NULL REFERENCES backup_it_parents(id), label text NOT NULL)");
    await pool.query("ALTER TABLE backup_it_parents ADD CONSTRAINT backup_it_parents_child_fk FOREIGN KEY(child_id) REFERENCES backup_it_children(id) DEFERRABLE INITIALLY DEFERRED");
    await pool.query("CREATE SEQUENCE backup_it_seq START 1 INCREMENT 1");
    await pool.query("SELECT setval('backup_it_seq', 50, true)");

    await assert.rejects(
      () => restoreBackupIntoCurrentDatabase(pool, { ...payload, tables: payload.tables.slice(1) }, true),
      /النسخة لا تحتوي جميع جداول النظام المطلوبة/,
      "restore must reject an archive missing a required table before importing any rows"
    );
    await assert.rejects(
      () => restoreBackupIntoCurrentDatabase(pool, { ...payload, sequences: [] }, true),
      /النسخة لا تحتوي جميع تسلسلات الترقيم المطلوبة/,
      "restore must reject an archive missing a required sequence"
    );
    await assert.rejects(
      () => restoreBackupIntoCurrentDatabase(pool, { ...payload, sequences: [...payload.sequences!, { ...payload.sequences![0]!, name: "unexpected_sequence" }] }, true),
      /النسخة لا تحتوي جميع تسلسلات الترقيم المطلوبة/,
      "restore must reject unexpected sequences"
    );
    await assert.rejects(
      () => restoreBackupIntoCurrentDatabase(pool, { ...payload, sequences: [...payload.sequences!, { ...payload.sequences![0]! }] }, true),
      /النسخة لا تحتوي جميع تسلسلات الترقيم المطلوبة/,
      "restore must reject duplicate sequence entries"
    );

    await pool.query("ALTER TABLE backup_it_parents DROP CONSTRAINT backup_it_parents_child_fk");
    await pool.query("ALTER TABLE backup_it_parents ADD CONSTRAINT backup_it_parents_child_fk FOREIGN KEY(child_id) REFERENCES backup_it_children(id) NOT DEFERRABLE");
    await assert.rejects(
      () => restoreBackupIntoCurrentDatabase(pool, payload, true),
      /توجد علاقات دائرية بين الجداول/,
      "restore must reject cycles that include non-deferrable foreign keys"
    );
    await pool.query("ALTER TABLE backup_it_parents DROP CONSTRAINT backup_it_parents_child_fk");
    await pool.query("ALTER TABLE backup_it_parents ADD CONSTRAINT backup_it_parents_child_fk FOREIGN KEY(child_id) REFERENCES backup_it_children(id) DEFERRABLE INITIALLY DEFERRED");

    const preview = await restoreBackupIntoCurrentDatabase(pool, payload, true);
    assert.equal(preview.added, 102, "preview must count records across multiple lookup batches");
    assert.equal(preview.conflicts.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM backup_it_parents")).rows[0].count, 0,
      "preview must roll back all inserted rows");

    const first = await restoreBackupIntoCurrentDatabase(pool, payload);
    assert.equal(first.added, 102, "restore must insert all records across multiple lookup batches");
    assert.equal(first.exactDuplicates, 0);
    assert.equal(first.conflicts.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM backup_it_children")).rows[0].count, 101);

    const second = await restoreBackupIntoCurrentDatabase(pool, payload);
    assert.equal(second.added, 0);
    assert.equal(second.exactDuplicates, 102, "restore must recognize exact duplicates across lookup batches");
    assert.equal(second.conflicts.length, 0);

    const conflictPayload: BackupPayload = {
      ...payload,
      tables: [
        {
          ...payload.tables[1]!,
          rows: [
            { id: parentId, child_id: childId, label: "changed-content" },
            { id: extraId, child_id: childId, label: "must-rollback" }
          ]
        },
        payload.tables[0]!
      ]
    };
    const conflict = await restoreBackupIntoCurrentDatabase(pool, conflictPayload);
    assert.equal(conflict.added, 0, "reported conflicts must roll back every row inserted by this restore");
    assert.equal(conflict.conflicts.length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM backup_it_parents")).rows[0].count, 1);
    assert.equal((await pool.query("SELECT label FROM backup_it_parents WHERE id=$1", [parentId])).rows[0].label, "parent");

    await assert.rejects(
      () => restoreBackupIntoCurrentDatabase(pool, payload, false, async () => {
        throw new Error("audit write failed");
      }),
      /audit write failed/
    );
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM backup_it_parents")).rows[0].count, 1,
      "audit failure must roll back the restore transaction");

    const auditFailureForwardPayload: BackupPayload = {
      ...payload,
      sequences: [{ name: "backup_it_seq", lastValue: "80", isCalled: true, incrementBy: "1", minValue: "1", maxValue: "9223372036854775807", startValue: "1", cacheSize: "1", cycle: false }]
    };
    await assert.rejects(
      () => restoreBackupIntoCurrentDatabase(pool, auditFailureForwardPayload, false, async () => {
        throw new Error("audit write failed before sequence advancement");
      }),
      /audit write failed before sequence advancement/
    );
    const sequenceAfterAuditFailure = await pool.query<{ last_value: string }>(
      "SELECT last_value::text FROM backup_it_seq"
    );
    assert.equal(sequenceAfterAuditFailure.rows[0]?.last_value, "50",
      "a failed audit must not leave a non-transactional sequence advance behind");

    const sequence = await pool.query<{ last_value: string; is_called: boolean }>(
      "SELECT last_value::text, is_called FROM backup_it_seq"
    );
    assert.equal(sequence.rows[0]?.last_value, "50",
      "restoring an older archive must never move a sequence backwards");
    assert.equal(sequence.rows[0]?.is_called, true);
    const forwardPayload: BackupPayload = {
      ...payload,
      sequences: [{ name: "backup_it_seq", lastValue: "75", isCalled: true, incrementBy: "1", minValue: "1", maxValue: "9223372036854775807", startValue: "1", cacheSize: "1", cycle: false }]
    };
    const forward = await restoreBackupIntoCurrentDatabase(pool, forwardPayload);
    assert.equal(forward.conflicts.length, 0);
    const advanced = await pool.query<{ last_value: string; is_called: boolean }>("SELECT last_value::text, is_called FROM backup_it_seq");
    assert.equal(advanced.rows[0]?.last_value, "75");
    assert.equal(advanced.rows[0]?.is_called, true);
    const mismatchPayload: BackupPayload = {
      ...forwardPayload,
      sequences: [{ ...forwardPayload.sequences![0]!, incrementBy: "2" }]
    };
    const mismatchPreview = await restoreBackupIntoCurrentDatabase(pool, mismatchPayload, true);
    assert.equal(mismatchPreview.conflicts.length, 1,
      "preview must report sequence configuration conflicts before confirmation");
    const afterPreview = await pool.query<{ last_value: string }>("SELECT last_value::text FROM backup_it_seq");
    assert.equal(afterPreview.rows[0]?.last_value, "75",
      "preview must not mutate sequence state");
    const mismatch = await restoreBackupIntoCurrentDatabase(pool, mismatchPayload);
    assert.equal(mismatch.conflicts.length, 1);
    const unchanged = await pool.query<{ last_value: string }>("SELECT last_value::text FROM backup_it_seq");
    assert.equal(unchanged.rows[0]?.last_value, "75");
  } finally {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
