import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { closeLegacyPool, inspectLegacyAndTarget } from "../src/modules/data-transfer/data-transfer.service.js";

const { Pool } = pg;

test("preflight compares two isolated PostgreSQL databases and reports index drift without blocking", {
  skip: !process.env.TEST_DATABASE_URL
}, async () => {
  const adminUrl = new URL(process.env.TEST_DATABASE_URL!);
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const sourceDb = `transfer_source_${suffix}`;
  const targetDb = `transfer_target_${suffix}`;
  const sourceRole = `transfer_reader_${suffix}`;
  const password = randomUUID();
  let sourceAdmin: pg.Pool | null = null;
  let targetPool: pg.Pool | null = null;
  let roleCreated = false;
  let sourceCreated = false;
  let targetCreated = false;
  const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

  try {
    await admin.query(`CREATE ROLE ${quoteIdentifier(sourceRole)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    roleCreated = true;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(sourceDb)}`);
    sourceCreated = true;
    await admin.query(`CREATE DATABASE ${quoteIdentifier(targetDb)}`);
    targetCreated = true;

    const sourceAdminUrl = new URL(adminUrl);
    sourceAdminUrl.pathname = `/${sourceDb}`;
    sourceAdmin = new Pool({ connectionString: sourceAdminUrl.toString(), max: 1 });
    await sourceAdmin.query("CREATE TABLE public.items (id integer PRIMARY KEY, label text NOT NULL)");
    await sourceAdmin.query("CREATE INDEX items_label_idx ON public.items (label)");
    await sourceAdmin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(sourceDb)} TO ${quoteIdentifier(sourceRole)}`);
    await sourceAdmin.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(sourceRole)}`);
    await sourceAdmin.query(`GRANT SELECT ON TABLE public.items TO ${quoteIdentifier(sourceRole)}`);

    const targetUrl = new URL(adminUrl);
    targetUrl.pathname = `/${targetDb}`;
    targetPool = new Pool({ connectionString: targetUrl.toString(), max: 1 });
    await targetPool.query("CREATE TABLE public.items (id integer PRIMARY KEY, label text NOT NULL)");

    const legacyUrl = new URL(adminUrl);
    legacyUrl.pathname = `/${sourceDb}`;
    legacyUrl.username = sourceRole;
    legacyUrl.password = password;
    process.env.LEGACY_DATABASE_URL = legacyUrl.toString();

    const report = await inspectLegacyAndTarget(targetPool);
    assert.equal(report.comparison.find(item => item.table === "items")?.status, "compatible");
    assert.deepEqual(report.indexWarnings.map(item => item.table), ["items"]);
    assert.equal(report.transferPlan.orderedTables.includes("items"), true);
    assert.equal(report.globalBlockers.length, 0);

    // Verify that pointing the read-only source at the target database is blocked.
    await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(targetDb)} TO ${quoteIdentifier(sourceRole)}`);
    await targetPool.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(sourceRole)}`);
    await targetPool.query(`GRANT SELECT ON TABLE public.items TO ${quoteIdentifier(sourceRole)}`);
    const sameDatabaseUrl = new URL(legacyUrl);
    sameDatabaseUrl.pathname = `/${targetDb}`;
    process.env.LEGACY_DATABASE_URL = sameDatabaseUrl.toString();
    await closeLegacyPool();
    const sameDatabaseReport = await inspectLegacyAndTarget(targetPool);
    assert.equal(
      sameDatabaseReport.globalBlockers.some(message => message.includes("المصدر والوجهة يشيران إلى قاعدة البيانات نفسها")),
      true
    );
    assert.equal(sameDatabaseReport.transferPlan.orderedTables.length, 0);
  } finally {
    await closeLegacyPool().catch(() => undefined);
    await sourceAdmin?.end().catch(() => undefined);
    await targetPool?.end().catch(() => undefined);
    delete process.env.LEGACY_DATABASE_URL;
    if (sourceCreated || targetCreated) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()",
        [[sourceDb, targetDb]]
      ).catch(() => undefined);
    }
    if (sourceCreated) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sourceDb)}`).catch(() => undefined);
    if (targetCreated) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(targetDb)}`).catch(() => undefined);
    if (roleCreated) await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(sourceRole)}`).catch(() => undefined);
    await admin.end();
  }
});
