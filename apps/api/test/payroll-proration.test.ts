import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;

function assertDisposableDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:",
    "TEST_DATABASE_URL must use PostgreSQL");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres");
}

test("payroll generation prorates mid-month salary changes and creates one item per employee", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_payroll_proration_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + databaseName;
  const db = new pg.Pool({ connectionString: target.toString() });
  try {
    // Minimal isolated schema: no factory or production records are read or modified.
    await db.query(`CREATE TABLE employees (
      id UUID PRIMARY KEY, is_active BOOLEAN NOT NULL DEFAULT TRUE
    )`);
    await db.query(`CREATE TABLE employee_salary_profiles (
      id UUID PRIMARY KEY, employee_id UUID NOT NULL REFERENCES employees(id),
      monthly_salary NUMERIC(18,2) NOT NULL, effective_from DATE NOT NULL, effective_to DATE
    )`);
    await db.query(`CREATE TABLE payroll_items (
      period_id UUID NOT NULL, employee_id UUID NOT NULL REFERENCES employees(id),
      salary_profile_id UUID REFERENCES employee_salary_profiles(id),
      base_salary NUMERIC(18,2) NOT NULL,
      UNIQUE(period_id,employee_id)
    )`);

    const employeeId = "00000000-0000-4000-8000-000000000001";
    const oldProfileId = "00000000-0000-4000-8000-000000000002";
    const newProfileId = "00000000-0000-4000-8000-000000000003";
    const periodId = "00000000-0000-4000-8000-000000000004";
    await db.query("INSERT INTO employees(id) VALUES ($1)", [employeeId]);
    await db.query(`INSERT INTO employee_salary_profiles(id,employee_id,monthly_salary,effective_from,effective_to)
      VALUES ($1,$3,3000,'2026-10-01','2026-10-14'),($2,$3,6200,'2026-10-15',NULL)`,
      [oldProfileId,newProfileId,employeeId]);

    const generate = () => db.query(`WITH month_bounds AS (
        SELECT $2::date AS month_start,
          ($2::date + INTERVAL '1 month - 1 day')::date AS month_end,
          (($2::date + INTERVAL '1 month')::date - $2::date)::numeric AS days_in_month
      ), profile_days AS (
        SELECT e.id AS employee_id, p.id AS profile_id, p.monthly_salary,
          GREATEST(p.effective_from,b.month_start) AS overlap_start,
          LEAST(COALESCE(p.effective_to,b.month_end),b.month_end) AS overlap_end,
          b.days_in_month
        FROM employees e
        JOIN employee_salary_profiles p ON p.employee_id=e.id
        CROSS JOIN month_bounds b
        WHERE e.is_active=TRUE
          AND p.effective_from <= b.month_end
          AND (p.effective_to IS NULL OR p.effective_to >= b.month_start)
      ), employee_totals AS (
        SELECT employee_id,
          (ARRAY_AGG(profile_id ORDER BY overlap_start DESC,profile_id DESC))[1] AS salary_profile_id,
          ROUND(SUM(monthly_salary * (overlap_end-overlap_start+1)::numeric / days_in_month),2) AS base_salary
        FROM profile_days
        GROUP BY employee_id
      )
      INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary)
      SELECT $1,e.id,t.salary_profile_id,t.base_salary
      FROM employees e JOIN employee_totals t ON t.employee_id=e.id
      ON CONFLICT(period_id,employee_id) DO NOTHING`, [periodId,"2026-10-01"]);

    await generate();
    await generate();
    const result = await db.query(
      "SELECT salary_profile_id,base_salary FROM payroll_items WHERE period_id=$1 AND employee_id=$2",
      [periodId,employeeId]
    );
    assert.equal(result.rowCount, 1, "regeneration must not create duplicate employee items");
    assert.equal(result.rows[0].salary_profile_id, newProfileId,
      "the latest overlapping profile should be the reference profile");
    // 14 days at 3,000 and 17 days at 6,200 in a 31-day month.
    assert.equal(Number(result.rows[0].base_salary), 4754.84);
  } finally {
    await db.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    try {
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
