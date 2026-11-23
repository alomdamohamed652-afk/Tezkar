import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertDisposableDatabaseUrl(value: string) {
  const url = new URL(value);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "test DB must be local");
  assert.equal(url.pathname.slice(1), "postgres", "test DB admin connection must target postgres");
}

test("cancelling paid production queues a review unless all of a payment is cancelled, and survives a refused auto reversal", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_cancel_share_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + databaseName;
  let apiPool: typeof import("../src/db/pool.js").pool | undefined;
  let app: { close: () => Promise<void> } | undefined;

  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-production-session-secret-long-enough";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { productionRoutes }, { settlePaidShareOnCancellation }, { hashPassword }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/production/production.routes.js"),
        import("../src/modules/production/cancellation-payment-reversal.service.js"),
        import("../src/modules/auth/auth.service.js"),
        import("../src/db/pool.js")
      ]);
    apiPool = poolModule.pool;
    void authRoutes; void productionRoutes; void cookie; void Fastify;
    const emp = (await apiPool.query("INSERT INTO employees(full_name) VALUES('Cancel Share Worker') RETURNING id")).rows[0];
    const mgrEmp = (await apiPool.query("INSERT INTO employees(full_name) VALUES('Cancel Share Manager') RETURNING id")).rows[0];
    const manager = (await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      ["cancelmgr-" + randomBytes(4).toString("hex"), hashPassword("Test-Cancel-Manager-2026!"), mgrEmp.id])).rows[0];
    await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager'", [manager.id]);
    const unit = (await apiPool.query("SELECT id FROM units WHERE code='PCS' LIMIT 1")).rows[0];
    const shift = (await apiPool.query("SELECT id FROM shifts WHERE code='MORNING' LIMIT 1")).rows[0];
    const stage = (await apiPool.query("INSERT INTO stages(name) VALUES('Cancel share stage') RETURNING id")).rows[0];
    const product = (await apiPool.query("INSERT INTO products(name,product_type,unit_id) VALUES('Cancel share product','FINISHED_GOOD',$1) RETURNING id", [unit.id])).rows[0];
    const wageType = (await apiPool.query("SELECT id,code,method FROM wage_types WHERE method='PER_PIECE' LIMIT 1")).rows[0];
    const order = (await apiPool.query("INSERT INTO production_orders(customer_name,order_date,status,created_by) VALUES('Cancel share order','2026-11-10','IN_PROGRESS',$1) RETURNING id", [manager.id])).rows[0];
    const orderStage = (await apiPool.query("INSERT INTO order_stages(order_id,stage_id,sequence_no,status) VALUES($1,$2,1,'IN_PROGRESS') RETURNING id", [order.id, stage.id])).rows[0];
    const makeEntry = async () => (await apiPool.query(
      `INSERT INTO production_entries(employee_id,product_id,stage_id,shift_id,order_stage_id,work_date,quantity,unit_id,rate_id,rate_snapshot,wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,earning_amount,status,submitted_by,approved_by,approved_at)
       VALUES($1,$2,$3,$4,$5,'2026-11-10',10,$6,NULL,10,$7,$8,$9,100,'APPROVED',$10,$11,now()) RETURNING id`,
      [emp.id, product.id, stage.id, shift.id, orderStage.id, unit.id, wageType.id, wageType.code, wageType.method, manager.id, manager.id])).rows[0];
    const a = await makeEntry();
    const b = await makeEntry();
    const payment = (await apiPool.query(
      "INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,created_at) VALUES($1,50,50,0,'CASH',$2,'2026-11-10') RETURNING id", [emp.id, manager.id])).rows[0];
    await apiPool.query("INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,30),($1,$3,20)", [payment.id, a.id, b.id]);
    const actor = { userId: manager.id, employeeId: mgrEmp.id, ip: null, userAgent: null };

    // 1) cancel only A: the payment still covers B, so it must be queued, not reversed.
    await apiPool.query("UPDATE production_entries SET status='CANCELLED' WHERE id=$1", [a.id]);
    const c1 = await apiPool.connect();
    try {
      await c1.query("BEGIN");
      const out = await settlePaidShareOnCancellation(c1, { productionEntryId: a.id, employeeId: emp.id, reason: "test cancel A", actor });
      await c1.query("COMMIT");
      assert.equal(out.length, 1);
      assert.equal(out[0].status, "OPEN");
      assert.equal(out[0].reasonCode, "PAYMENT_HAS_OTHER_ACTIVE_PRODUCTION");
    } finally { c1.release(); }

    // 2) cancel B too: auto reversal is attempted; this synthetic payment has no matching settlement/expense rows, so the
    //    reversal refuses. The savepoint must roll back cleanly and the case must land in the review queue with the reason.
    await apiPool.query("UPDATE production_entries SET status='CANCELLED' WHERE id=$1", [b.id]);
    const c2 = await apiPool.connect();
    try {
      await c2.query("BEGIN");
      const out = await settlePaidShareOnCancellation(c2, { productionEntryId: b.id, employeeId: emp.id, reason: "test cancel B", actor });
      await c2.query("COMMIT");
      assert.equal(out.length, 1);
      assert.equal(out[0].status, "OPEN");
      assert.equal(out[0].reasonCode, "AUTO_REVERSAL_REFUSED");
    } finally { c2.release(); }

    const rows = (await apiPool.query("SELECT production_entry_id,status,reason_code,allocated_amount::float8 AS amt FROM production_cancellation_payment_reviews WHERE worker_payment_id=$1 ORDER BY allocated_amount DESC", [payment.id])).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r: any) => r.amt), [30, 20]);
    const reversals = (await apiPool.query("SELECT COUNT(*)::int AS n FROM financial_reversal_lines WHERE source_id=$1", [payment.id])).rows[0].n;
    assert.equal(reversals, 0, "a refused auto reversal must leave no partial financial writes");
  } finally {
    if (app) await app.close().catch(() => undefined);
    if (apiPool) await apiPool.end().catch(() => undefined);
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
