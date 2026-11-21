import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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

test("worker production API preserves paid, remaining, reversal and adjustment totals across allocation sources", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_production_api_" + randomBytes(6).toString("hex");
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

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { productionRoutes }, { hashPassword }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/production/production.routes.js"),
        import("../src/modules/auth/auth.service.js"),
        import("../src/db/pool.js")
      ]);
    apiPool = poolModule.pool;

    const server = Fastify();
    app = server;
    await server.register(cookie, { secret: process.env.SESSION_SECRET });
    server.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await server.register(authRoutes);
    await server.register(productionRoutes);

    const workerEmployee = (await apiPool.query(
      "INSERT INTO employees(full_name) VALUES('Production Integration Worker') RETURNING id"
    )).rows[0];
    const managerEmployee = (await apiPool.query(
      "INSERT INTO employees(full_name) VALUES('Production Integration Manager') RETURNING id"
    )).rows[0];
    const workerPassword = "Test-Production-Worker-2026!";
    const worker = (await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      ["prodwrk-" + randomBytes(4).toString("hex"), hashPassword(workerPassword), workerEmployee.id]
    )).rows[0];
    const manager = (await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      ["prodmgr-" + randomBytes(4).toString("hex"), hashPassword("Test-Production-Manager-2026!"), managerEmployee.id]
    )).rows[0];
    await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker'", [worker.id]);
    await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager'", [manager.id]);

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: (await apiPool.query("SELECT username FROM users WHERE id=$1", [worker.id])).rows[0].username,
        password: workerPassword }
    });
    assert.equal(login.statusCode, 200, login.body);
    const setCookie = login.headers["set-cookie"];
    assert.ok(setCookie);
    const workerCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];

    const unit = (await apiPool.query("SELECT id FROM units WHERE code='PCS' LIMIT 1")).rows[0];
    const shift = (await apiPool.query("SELECT id FROM shifts WHERE code='MORNING' LIMIT 1")).rows[0];
    const stage = (await apiPool.query(
      "INSERT INTO stages(name) VALUES('Production integration stage') RETURNING id"
    )).rows[0];
    const product = (await apiPool.query(
      "INSERT INTO products(name,product_type,unit_id) VALUES('Production integration product','FINISHED_GOOD',$1) RETURNING id",
      [unit.id]
    )).rows[0];
    const wageType = (await apiPool.query(
      "SELECT id,code,method FROM wage_types WHERE method='PER_PIECE' LIMIT 1"
    )).rows[0];

    const sourceOrder = (await apiPool.query(
      "INSERT INTO production_orders(customer_name,order_date,status,created_by) VALUES('Production integration order','2026-11-10','IN_PROGRESS',$1) RETURNING id",
      [manager.id]
    )).rows[0];
    const orderStage = (await apiPool.query(
      "INSERT INTO order_stages(order_id,stage_id,sequence_no,status) VALUES($1,$2,1,'IN_PROGRESS') RETURNING id",
      [sourceOrder.id, stage.id]
    )).rows[0];

    const production = (await apiPool.query(
      `INSERT INTO production_entries(
         employee_id,product_id,stage_id,shift_id,order_stage_id,work_date,quantity,unit_id,rate_id,
         rate_snapshot,wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,
         earning_amount,status,submitted_by,approved_by,approved_at
       ) VALUES($1,$2,$3,$4,$5,'2026-11-10',10,$6,NULL,10,$7,$8,$9,100,'APPROVED',$10,$11,now())
       RETURNING id`,
      [workerEmployee.id, product.id, stage.id, shift.id, orderStage.id, unit.id, wageType.id,
        wageType.code, wageType.method, worker.id, manager.id]
    )).rows[0];

    // This payment has a canonical settlement allocation plus a separately tracked
    // unmatched amount. The difference event must add to production paid exactly once.
    const canonicalPayment = (await apiPool.query(
      `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,created_at)
       VALUES($1,45,45,0,'CASH',$2,'2026-11-10') RETURNING id`,
      [workerEmployee.id, manager.id]
    )).rows[0];
    const settlement = (await apiPool.query(
      `INSERT INTO employee_earnings_settlements(
         employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,created_by,worker_payment_id
       ) VALUES($1,30,30,0,'2026-11-10',$2,$3) RETURNING id`,
      [workerEmployee.id, manager.id, canonicalPayment.id]
    )).rows[0];
    const settlementAllocation = (await apiPool.query(
      "INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,30) RETURNING id",
      [settlement.id, production.id]
    )).rows[0];

    const canonicalOrderAllocation = (await apiPool.query(
      "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,15) RETURNING id",
      [canonicalPayment.id, production.id]
    )).rows[0];
    const sourceExpense = (await apiPool.query(
      `INSERT INTO accounting_expenses(
         order_id,category,description,amount,expense_date,created_by,source_worker_payment_id
       ) VALUES($1,'WORKER_PAYMENT','Integration worker payment with unmatched difference',45,'2026-11-10',$2,$3)
       RETURNING id`,
      [sourceOrder.id, manager.id, canonicalPayment.id]
    )).rows[0];
    const difference = (await apiPool.query(
      `INSERT INTO worker_payment_settlement_differences(
         worker_payment_id,employee_id,source_order_id,source_order_stage_id,source_expense_id,
         original_amount,payment_date,eligible_at,created_by
       ) VALUES($1,$2,$3,$4,$5,15,'2026-11-10','2026-11-10',$6) RETURNING id`,
      [canonicalPayment.id, workerEmployee.id, sourceOrder.id, orderStage.id, sourceExpense.id, manager.id]
    )).rows[0];
    const differenceAllocation = (await apiPool.query(
      `INSERT INTO worker_payment_settlement_difference_events(
         difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,
         target_order_id,target_order_stage_id,production_entry_id,worker_payment_order_allocation_id,
         actor_type,actor_user_id,reason
       ) VALUES($1,$2,$3,'ALLOCATED_TO_PRODUCTION',15,$4,$4,$5,$6,$7,'USER',$8,'Integration allocation')
       RETURNING id`,
      [difference.id, canonicalPayment.id, sourceExpense.id, sourceOrder.id, orderStage.id,
        production.id, canonicalOrderAllocation.id, manager.id]
    )).rows[0];

    const orderPayment = (await apiPool.query(
      `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,created_at)
       VALUES($1,20,20,0,'CASH',$2,'2026-11-10') RETURNING id`,
      [workerEmployee.id, manager.id]
    )).rows[0];
    await apiPool.query(
      "INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,20)",
      [orderPayment.id, production.id]
    );

    const legacyPayment = (await apiPool.query(
      `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,paid_by,created_at)
       VALUES($1,10,10,0,'CASH',$2,'2026-11-10') RETURNING id`,
      [workerEmployee.id, manager.id]
    )).rows[0];
    const legacyAllocation = (await apiPool.query(
      "INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,10) RETURNING id",
      [legacyPayment.id, production.id]
    )).rows[0];

    const reversal = (await apiPool.query(
      "INSERT INTO financial_reversals(idempotency_key,request_fingerprint,reason,created_by) VALUES($1,'production-api-test','Reverse part of legacy allocation',$2) RETURNING id",
      [randomUUID(), manager.id]
    )).rows[0];
    await apiPool.query(
      `INSERT INTO worker_payment_allocation_reversals(
         reversal_id,worker_payment_id,allocation_source,source_allocation_id,production_entry_id,amount,created_by
       ) VALUES($1,$2,'WORKER_PAYMENT_LEGACY',$3,$4,5,$5)`,
      [reversal.id, legacyPayment.id, legacyAllocation.id, production.id, manager.id]
    );

    await apiPool.query(
      `INSERT INTO employee_earnings_adjustments(employee_id,production_entry_id,adjustment_type,amount,reason,adjustment_date,created_by)
       VALUES($1,$2,'BONUS',50,'Linked production adjustment','2026-11-10',$3)`,
      [workerEmployee.id, production.id, manager.id]
    );
    await apiPool.query(
      `INSERT INTO employee_earnings_adjustments(employee_id,adjustment_type,amount,reason,adjustment_date,created_by)
       VALUES($1,'BONUS',7,'Standalone adjustment','2026-11-10',$2)`,
      [workerEmployee.id, manager.id]
    );

    const response = await server.inject({
      method: "GET",
      url: "/api/production/my?from=2026-11-10&to=2026-11-10",
      headers: { cookie: workerCookie }
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, production.id);
    assert.equal(Number(body.data[0].paid_amount), 70,
      "settlement, difference event, order and legacy sources must be counted once, net of the legacy reversal");
    assert.equal(Number(body.data[0].remaining_amount), 30,
      "remaining must subtract the same active allocations as paid");
    assert.equal(body.adjustments.length, 2,
      "the worker adjustment list must retain linked and standalone adjustments");
    assert.equal(body.daily.length, 1);
    assert.equal(Number(body.daily[0].production_earned), 100);
    assert.equal(Number(body.daily[0].bonuses), 7,
      "the linked adjustment is already represented by production and must not be counted again");
    assert.equal(Number(body.daily[0].net_earned), 107);

    // Reverse the append-only difference event, not the original allocation row.
    const differenceReversal = (await apiPool.query(
      `INSERT INTO financial_reversals(idempotency_key,request_fingerprint,reason,created_by)
       VALUES($1,'production-api-difference-reversal','Reverse difference allocation in integration test',$2)
       RETURNING id`,
      [randomUUID(), manager.id]
    )).rows[0];
    await apiPool.query(
      `INSERT INTO worker_payment_settlement_difference_events(
         difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,
         target_order_id,target_order_stage_id,reverses_event_id,financial_reversal_id,
         actor_type,actor_user_id,reason
       ) VALUES($1,$2,$3,'REVERSED',15,$4,$4,$5,$6,$7,'USER',$8,'Integration reversal')`,
      [difference.id, canonicalPayment.id, sourceExpense.id, sourceOrder.id, orderStage.id,
        differenceAllocation.id, differenceReversal.id, manager.id]
    );
    const afterDifferenceReversal = await server.inject({
      method: "GET",
      url: "/api/production/my?from=2026-11-10&to=2026-11-10",
      headers: { cookie: workerCookie }
    });
    assert.equal(afterDifferenceReversal.statusCode, 200, afterDifferenceReversal.body);
    const afterReversalBody = afterDifferenceReversal.json();
    assert.equal(Number(afterReversalBody.data[0].paid_amount), 55,
      "reversing the difference event must restore exactly 15 to the worker's remaining due");
    assert.equal(Number(afterReversalBody.data[0].remaining_amount), 45,
      "the reversed difference event must no longer reduce remaining production dues");

    const otherWorker = (await apiPool.query(
      "INSERT INTO employees(full_name) VALUES('Other Production Worker') RETURNING id"
    )).rows[0];
    await apiPool.query(
      `INSERT INTO production_entries(
         employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,
         rate_snapshot,wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,
         earning_amount,status,submitted_by,approved_by,approved_at
       ) VALUES($1,$2,$3,$4,'2026-11-10',2,$5,NULL,10,$6,$7,$8,999,'APPROVED',$9,$10,now())`,
      [otherWorker.id, product.id, stage.id, shift.id, unit.id, wageType.id,
        wageType.code, wageType.method, worker.id, manager.id]
    );
    const isolation = await server.inject({
      method: "GET",
      url: "/api/production/my?from=2026-11-10&to=2026-11-10",
      headers: { cookie: workerCookie }
    });
    assert.equal(isolation.statusCode, 200, isolation.body);
    assert.equal(isolation.json().data.length, 1,
      "the endpoint must never return another employee's production");
    assert.equal(Number(isolation.json().daily[0].production_earned), 100,
      "another employee's earnings must not leak into the worker daily summary");

    await server.close();
    app = undefined;
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
