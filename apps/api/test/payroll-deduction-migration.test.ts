import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("payroll deduction migration preserves legacy fixed deductions and enforces percentage rules", {
  skip: !testDatabaseUrl
}, async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
  const client = await pool.connect();
  const schema = "payroll_migration_test_" + randomUUID().replaceAll("-", "");
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await client.query(`CREATE TABLE payroll_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_salary NUMERIC(18,2) NOT NULL DEFAULT 0,
      bonus_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      deduction_amount NUMERIC(18,2) NOT NULL DEFAULT 0
    )`);
    const legacy = await client.query(
      "INSERT INTO payroll_items(base_salary,bonus_amount,deduction_amount) VALUES(6000,200,150) RETURNING id"
    );
    const migration = await readFile(new URL("../src/db/migrations/1012_payroll_deduction_options.sql", import.meta.url), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(migration);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING", ["1012_payroll_deduction_options"]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const oldItem = await client.query(
      "SELECT deduction_mode,deduction_percentage,deduction_basis,deduction_amount FROM payroll_items WHERE id=$1",
      [legacy.rows[0].id]
    );
    assert.equal(oldItem.rows[0].deduction_mode, "FIXED");
    assert.equal(oldItem.rows[0].deduction_percentage, null);
    assert.equal(oldItem.rows[0].deduction_basis, "BASE_SALARY");
    assert.equal(Number(oldItem.rows[0].deduction_amount), 150);

    await client.query(
      "INSERT INTO payroll_items(base_salary,deduction_amount,deduction_mode,deduction_percentage,deduction_basis) VALUES(6000,300,'PERCENTAGE',5,'BASE_SALARY')"
    );
    await assert.rejects(
      client.query("INSERT INTO payroll_items(base_salary,deduction_mode,deduction_basis) VALUES(6000,'PERCENTAGE','BASE_SALARY')"),
      /payroll_items_percentage_mode_requires_percentage/
    );
    await assert.rejects(
      client.query("INSERT INTO payroll_items(base_salary,deduction_mode,deduction_percentage,deduction_basis) VALUES(6000,'PERCENTAGE',101,'BASE_SALARY')"),
      /payroll_items_deduction_percentage_range/
    );
    const applied = await client.query("SELECT version FROM schema_migrations WHERE version=$1", ["1012_payroll_deduction_options"]);
    assert.equal(applied.rowCount, 1);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});
