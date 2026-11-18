import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabaseBackupStream } from "../src/modules/backup/backup-database.service.js";
import { readBackupArchive } from "../src/modules/backup/backup-archive.js";

const adminUrl = process.env.TEST_DATABASE_URL;

function assertDisposableDatabaseUrl(value: string): void {
  const url = new URL(value);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "backup export integration tests require a local disposable PostgreSQL server");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must connect to the postgres admin database, never an application database");
}

test("database backup streams bounded cursor batches into an authenticated v2 archive", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);

  const databaseName = "tezkar_backup_export_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = "/" + databaseName;
  const pool = new pg.Pool({ connectionString: targetUrl.toString(), max: 1 });
  const password = "a-strong-backup-password";
  let auditCompleted = 0;

  try {
    await pool.query("CREATE TABLE schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await pool.query("INSERT INTO schema_migrations(version) VALUES ('stream-export-test')");
    await pool.query("CREATE SEQUENCE backup_stream_seq START 1 INCREMENT 1 CACHE 1");
    await pool.query(`
      CREATE TABLE backup_stream_rows(
        id bigint PRIMARY KEY DEFAULT nextval('backup_stream_seq'),
        amount numeric(18,4) NOT NULL,
        note text NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);
    await pool.query(`
      INSERT INTO backup_stream_rows(amount,note,created_at)
      SELECT (n::numeric / 7)::numeric(18,4),
             CASE WHEN n % 2 = 0 THEN 'سجل عربي ' || n::text ELSE 'row-' || n::text END,
             '2026-11-18 08:30:00.123456+00'::timestamptz
        FROM generate_series(1, 1205) AS n
    `);

    const chunks: Buffer[] = [];
    const archiveStream = createDatabaseBackupStream(pool, password, async () => {
      auditCompleted += 1;
    });
    for await (const chunk of archiveStream) chunks.push(Buffer.from(chunk));
    const archive = Buffer.concat(chunks);
    const restored = await readBackupArchive(archive, password);

    assert.equal(auditCompleted, 1, "export audit callback must run once after the complete encrypted body is produced");
    assert.equal(restored.version, 1);
    assert.equal(restored.sourceSchemaVersion, "stream-export-test");
    assert.equal(restored.tables.length, 1);
    assert.equal(restored.tables[0]?.name, "backup_stream_rows");
    assert.equal(restored.tables[0]?.rows.length, 1205, "all rows must be emitted across multiple cursor fetch batches");
    assert.equal(restored.tables[0]?.rows.find(row => row.id === "1")?.amount, "0.1429");
    assert.equal(restored.tables[0]?.rows.find(row => row.id === "2")?.note, "سجل عربي 2");
    assert.ok(restored.tables[0]?.rows.some(row => row.id === "1205"),
      "the final inserted row must be present regardless of PostgreSQL scan order");
    assert.equal(restored.sequences?.length, 1);
    assert.equal(restored.sequences?.[0]?.name, "backup_stream_seq");
    assert.equal(restored.sequences?.[0]?.lastValue, "1205");

    // Simulate a browser closing the download after encrypted bytes have begun.
    // The stream must cancel its cursor transaction and must not write a success audit.
    const cancelled = createDatabaseBackupStream(pool, password, async () => {
      auditCompleted += 100;
    });
    const iterator = cancelled[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    assert.equal(firstChunk.done, false, "stream should emit its archive header");
    const encryptedChunk = await iterator.next();
    assert.equal(encryptedChunk.done, false, "stream should begin encrypted output before the download completes");
    cancelled.destroy();
    await new Promise<void>(resolve => cancelled.once("close", resolve));
    await pool.query("SELECT 1");
    assert.equal(auditCompleted, 1, "an interrupted download must not be audited as a completed export");
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
