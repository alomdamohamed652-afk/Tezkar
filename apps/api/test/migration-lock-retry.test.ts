import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationName = "2026111201_worker_difference_reallocation_cycles";

test("migration runner retries a transient lock timeout and reports the migration", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  const adminTarget = new URL(adminUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(adminTarget.hostname.toLowerCase()),
    "migration lock test must use a local disposable PostgreSQL server");
  assert.equal(adminTarget.pathname.slice(1), "postgres",
    "test DB admin connection must target postgres");

  const databaseName = "tezkar_migration_lock_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + databaseName;
  let blocker: pg.Client | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";

  try {
    const setup = new pg.Client({ connectionString: target.toString() });
    await setup.connect();
    try {
      await setup.query(`
        CREATE TABLE schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE worker_payment_order_allocations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          worker_payment_id UUID NOT NULL,
          production_entry_id UUID NOT NULL,
          amount NUMERIC(14,2) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (worker_payment_id, production_entry_id)
        );
        CREATE TABLE worker_payment_settlement_difference_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          difference_id UUID NOT NULL,
          production_entry_id UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          event_type TEXT NOT NULL
        );
        CREATE UNIQUE INDEX worker_payment_settlement_difference_allocation_uq
          ON worker_payment_settlement_difference_events(difference_id, production_entry_id)
          WHERE event_type='ALLOCATED_TO_PRODUCTION';
      `);

      const migrationFiles = (await readdir(path.resolve(apiDir, "src/db/migrations")))
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .map((name) => name.replace(/\.sql$/, ""))
        .filter((name) => name !== migrationName);
      await setup.query(
        "INSERT INTO schema_migrations(version) SELECT unnest($1::text[])",
        [migrationFiles]
      );
    } finally {
      await setup.end();
    }

    blocker = new pg.Client({ connectionString: target.toString() });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE worker_payment_order_allocations IN ACCESS EXCLUSIVE MODE");

    child = spawn(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const retryNotice = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        "migration runner did not report a lock timeout; output: " + output
      )), 25_000);
      const consume = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(`lock timeout: ${migrationName}.sql; retrying`)) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child!.stdout.on("data", consume);
      child!.stderr.on("data", consume);
      child!.once("exit", (code) => {
        if (!output.includes(`lock timeout: ${migrationName}.sql; retrying`)) {
          clearTimeout(timeout);
          reject(new Error(`migration runner exited before retrying (code ${code}); output: ${output}`));
        }
      });
    });

    await retryNotice;
    const diagnosticDeadline = Date.now() + 5_000;
    while (!output.includes("migration lock holders:") && Date.now() < diagnosticDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(output.includes("migration lock holders:"), output);
    await blocker.query("COMMIT");
    await blocker.end();
    blocker = undefined;

    const result = await exit;
    assert.equal(result.code, 0, output);
    assert.ok(output.includes(`applying: ${migrationName}.sql (attempt 2/3)`), output);
    assert.match(output, new RegExp(`applied: ${migrationName}.sql`));

    const verification = new pg.Client({ connectionString: target.toString() });
    await verification.connect();
    try {
      const uniqueConstraint = await verification.query(
        `SELECT 1 FROM pg_constraint
          WHERE conrelid='worker_payment_order_allocations'::regclass AND contype='u'`
      );
      assert.equal(uniqueConstraint.rowCount, 0,
        "the old pair uniqueness must be removed so a reversed allocation can be re-created");

      const indexes = await verification.query(
        "SELECT indexname FROM pg_indexes WHERE tablename IN ($1, $2)",
        ["worker_payment_order_allocations", "worker_payment_settlement_difference_events"]
      );
      const names = indexes.rows.map((row: { indexname: string }) => row.indexname);
      assert.ok(names.includes("worker_payment_order_allocations_payment_production_idx"));
      assert.ok(names.includes("worker_payment_settlement_difference_allocation_history_idx"));
      assert.ok(!names.includes("worker_payment_settlement_difference_allocation_uq"));
    } finally {
      await verification.end();
    }
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (blocker) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
