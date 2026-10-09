import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertDisposableDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  assert.ok(
    url.protocol === "postgres:" || url.protocol === "postgresql:",
    "TEST_DATABASE_URL must use PostgreSQL"
  );
  assert.ok(
    ["localhost", "127.0.0.1", "::1", "postgres"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server"
  );
  assert.equal(
    url.pathname.replace(/^\\/+/, ""),
    "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres"
  );
}

async function withPayrollDatabase(run: (db: pg.Pool) => Promise<void>) {
  assert.ok(adminUrl, "TEST_DATABASE_URL must point to a disposable PostgreSQL test server");
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_payroll_test_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + name;
  const db = new pg.Pool({ connectionString: target.toString(), max: 8 });
  try {
    const runMigrations = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: "utf8"
    });
    assert.equal(runMigrations.status, 0, runMigrations.stderr || runMigrations.stdout);
    await run(db);
  } finally {
    await db.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    try {
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
}

async function seedPayroll(db: pg.Pool) {
  const employee = await db.query(
    "INSERT INTO employees(full_name) VALUES ('Payroll Test Employee') RETURNING id"
  );
  const user = await db.query(
    "INSERT INTO users(username,password_hash,employee_id) VALUES ($1,'test-only-hash',$2) RETURNING id",
    ["payroll-test-" + randomBytes(5).toString("hex"), employee.rows[0].id]
  );
  const period = await db.query(
    "INSERT INTO payroll_periods(period_month,generated_by) VALUES ('2099-01-01',$1) RETURNING id",
    [user.rows[0].id]
  );
  const profile = await db.query(
    "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,1000,'2098-01-01',$2) RETURNING id",
    [employee.rows[0].id, user.rows[0].id]
  );
  const item = await db.query(
    "INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,1000,100,100) RETURNING id,net_amount,status",
    [period.rows[0].id, employee.rows[0].id, profile.rows[0].id]
  );
  return { employeeId: employee.rows[0].id, userId: user.rows[0].id, periodId: period.rows[0].id, itemId: item.rows[0].id };
}

test("payroll schema preserves one item per employee and period and computes net pay", { skip: !adminUrl && "TEST_DATABASE_URL not set" }, async () => {
  await withPayrollDatabase(async db => {
    const ids = await seedPayroll(db);
    const item = await db.query("SELECT net_amount FROM payroll_items WHERE id=$1", [ids.itemId]);
    assert.equal(Number(item.rows[0].net_amount), 1000);

    await assert.rejects(
      db.query(
        "INSERT INTO payroll_items(period_id,employee_id,base_salary) VALUES ($1,$2,1000)",
        [ids.periodId, ids.employeeId]
      ),
      (error: unknown) => (error as { code?: string }).code === "23505"
    );
  });
});

test("payroll payment transaction serializes concurrent payments and rejects overpayment", { skip: !adminUrl && "TEST_DATABASE_URL not set" }, async () => {
  await withPayrollDatabase(async db => {
    const ids = await seedPayroll(db);
    await db.query("UPDATE payroll_periods SET status='APPROVED' WHERE id=$1", [ids.periodId]);

    async function pay(amount: number) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const row = await client.query(
          "SELECT i.net_amount,p.status AS period_status FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id WHERE i.id=$1 FOR UPDATE OF i,p",
          [ids.itemId]
        );
        assert.equal(row.rows[0].period_status, "APPROVED");
        const paid = await client.query(
          "SELECT COALESCE(SUM(amount),0) AS amount FROM payroll_payments WHERE payroll_item_id=$1",
          [ids.itemId]
        );
        const remaining = Number(row.rows[0].net_amount) - Number(paid.rows[0].amount);
        if (amount > remaining + 0.0001) {
          await client.query("ROLLBACK");
          return { rejected: true, remaining };
        }
        await client.query(
          "INSERT INTO payroll_payments(payroll_item_id,amount,paid_by) VALUES ($1,$2,$3)",
          [ids.itemId, amount, ids.userId]
        );
        const newPaid = Number(paid.rows[0].amount) + amount;
        const status = newPaid >= Number(row.rows[0].net_amount) - 0.0001 ? "PAID" : "PARTIAL";
        await client.query("UPDATE payroll_items SET status=$1 WHERE id=$2", [status, ids.itemId]);
        await client.query("COMMIT");
        return { rejected: false, remaining: Math.max(0, Number(row.rows[0].net_amount) - newPaid), status };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const first = await pay(600);
    assert.deepEqual(first, { rejected: false, remaining: 400, status: "PARTIAL" });
    const second = await pay(400);
    assert.deepEqual(second, { rejected: false, remaining: 0, status: "PAID" });
    const overpay = await pay(0.01);
    assert.equal(overpay.rejected, true);
    assert.equal(overpay.remaining, 0);

    const totals = await db.query(
      "SELECT COALESCE(SUM(pp.amount),0) AS paid, i.net_amount, i.status FROM payroll_items i LEFT JOIN payroll_payments pp ON pp.payroll_item_id=i.id WHERE i.id=$1 GROUP BY i.id",
      [ids.itemId]
    );
    assert.equal(Number(totals.rows[0].paid), 1000);
    assert.equal(Number(totals.rows[0].net_amount), 1000);
    assert.equal(totals.rows[0].status, "PAID");
  });
});

test("simultaneous payroll payments cannot exceed the remaining amount", { skip: !adminUrl && "TEST_DATABASE_URL not set" }, async () => {
  await withPayrollDatabase(async db => {
    const ids = await seedPayroll(db);
    await db.query("UPDATE payroll_periods SET status='APPROVED' WHERE id=$1", [ids.periodId]);

    async function concurrentPay(amount: number) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const row = await client.query(
          "SELECT i.net_amount FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id WHERE i.id=$1 FOR UPDATE OF i,p",
          [ids.itemId]
        );
        const paid = await client.query(
          "SELECT COALESCE(SUM(amount),0) AS amount FROM payroll_payments WHERE payroll_item_id=$1",
          [ids.itemId]
        );
        const remaining = Number(row.rows[0].net_amount) - Number(paid.rows[0].amount);
        if (amount > remaining + 0.0001) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query(
          "INSERT INTO payroll_payments(payroll_item_id,amount,paid_by) VALUES ($1,$2,$3)",
          [ids.itemId, amount, ids.userId]
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const results = await Promise.all([concurrentPay(700), concurrentPay(700)]);
    assert.equal(results.filter(Boolean).length, 1);
    const totals = await db.query("SELECT SUM(amount) AS paid FROM payroll_payments WHERE payroll_item_id=$1", [ids.itemId]);
    assert.equal(Number(totals.rows[0].paid), 700);
  });
});
