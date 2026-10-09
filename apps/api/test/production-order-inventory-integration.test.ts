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
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:", "TEST_DATABASE_URL must use PostgreSQL");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()), "TEST_DATABASE_URL must point to local disposable PostgreSQL");
  assert.equal(url.pathname.slice(1), "postgres", "TEST_DATABASE_URL must use the disposable admin database named postgres");
}

test("order -> staged production -> approval -> inventory lot and order dashboard stays consistent", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const dbName = "tezkar_prod_order_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + dbName;
  let apiPool: typeof import("../src/db/pool.js").pool | undefined;
  let app: import("fastify").FastifyInstance | undefined;

  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-production-order-session-secret";
    process.env.NODE_ENV = "test";

    const [
      { default: Fastify }, { default: cookie }, { authRoutes }, { productionRoutes },
      { orderRoutes }, { warehouseRoutes }, { accountingRoutes }, { hashPassword },
      poolModule
    ] = await Promise.all([
      import("fastify"), import("@fastify/cookie"), import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/production/production.routes.js"), import("../src/modules/orders/orders.routes.js"),
      import("../src/modules/warehouse/warehouse.routes.js"), import("../src/modules/accounting/accounting.routes.js"),
      import("../src/modules/auth/auth.service.js"), import("../src/db/pool.js")
    ]);
    apiPool = poolModule.pool;
    app = Fastify();
    await app.register(cookie, { secret: process.env.SESSION_SECRET });
    app.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await app.register(authRoutes);
    await app.register(productionRoutes);
    await app.register(orderRoutes);
    await app.register(warehouseRoutes);
    await app.register(accountingRoutes);

    async function makeUser(label: string, withEmployee: boolean) {
      let employeeId: string | null = null;
      if (withEmployee) {
        const employee = await apiPool!.query("INSERT INTO employees(full_name) VALUES($1) RETURNING id", [label + " Employee"]);
        employeeId = employee.rows[0].id;
      }
      const username = label.toLowerCase() + "-" + randomBytes(5).toString("hex");
      const user = await apiPool!.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [username, hashPassword("Test-only-password-2026!"), employeeId]
      );
      await apiPool!.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
        [user.rows[0].id]
      );
      await apiPool!.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING"
      );
      const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "Test-only-password-2026!" } });
      assert.equal(login.statusCode, 200, login.body);
      const setCookie = login.headers["set-cookie"];
      assert.ok(setCookie);
      const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
      return { userId: user.rows[0].id as string, employeeId, cookie: cookieHeader };
    }

    const submitter = await makeUser("submitter", true);
    const approver = await makeUser("approver", true);
    const shift = await apiPool.query(
      "SELECT id,rate_group_id FROM shifts WHERE is_active=TRUE AND rate_group_id IS NOT NULL ORDER BY created_at,id LIMIT 1"
    );
    assert.ok(shift.rowCount, "migrations must seed an active shift and rate group");

    const orderResponse = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: {
        orderName: "Integration order",
        customerName: "Test-only customer",
        orderDate: "2099-01-01",
        stages: [
          { stageName: "Integration WIP stage", sequenceNo: 1, outputProductName: "Integration component", plannedQuantity: 10, stageRate: 20, stageRateMethod: "PER_PIECE" },
          { stageName: "Integration final stage", sequenceNo: 2, outputProductName: "Integration finished item", plannedQuantity: 10, stageRate: 30, stageRateMethod: "PER_PIECE" }
        ]
      }
    });
    assert.equal(orderResponse.statusCode, 201, orderResponse.body);
    const orderId = orderResponse.json().data.id as string;
    const stagesResult = await apiPool.query(
      "SELECT os.id,os.stage_id,os.output_product_id,os.sequence_no,os.stage_rate,os.stage_rate_method,p.unit_id FROM order_stages os JOIN products p ON p.id=os.output_product_id WHERE os.order_id=$1 ORDER BY os.sequence_no",
      [orderId]
    );
    assert.equal(stagesResult.rows.length, 2);
    const [wipStage, finalStage] = stagesResult.rows;

    const whs = await apiPool.query(
      "SELECT id,warehouse_type FROM warehouses WHERE is_active=TRUE AND warehouse_type IN ('WIP','FINISHED_GOODS') ORDER BY created_at,id"
    );
    const expectedWip = whs.rows.find((x: {warehouse_type:string})=>x.warehouse_type==="WIP");
    const expectedFinished = whs.rows.find((x: {warehouse_type:string})=>x.warehouse_type==="FINISHED_GOODS");
    assert.ok(expectedWip && expectedFinished, "migrations must create WIP and finished-goods virtual warehouses");
    const wrongWarehouse = await apiPool.query(
      "SELECT id,warehouse_type FROM warehouses WHERE is_active=TRUE AND warehouse_type='RAW_MATERIAL' ORDER BY created_at,id LIMIT 1"
    );
    assert.ok(wrongWarehouse.rowCount);
    await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name,is_active) VALUES($1,'INTEGRATION-RAW','Integration raw location',TRUE) ON CONFLICT(warehouse_id,code) DO NOTHING",
      [wrongWarehouse.rows[0].id]
    );
    await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name,is_active) VALUES($1,'INTEGRATION-WIP','Integration WIP location',TRUE) ON CONFLICT(warehouse_id,code) DO NOTHING",
      [expectedWip.id]
    );
    await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name,is_active) VALUES($1,'INTEGRATION-FG','Integration finished location',TRUE) ON CONFLICT(warehouse_id,code) DO NOTHING",
      [expectedFinished.id]
    );
    const wrongLoc = await apiPool.query(
      "SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",
      [wrongWarehouse.rows[0].id]
    );
    assert.ok(wrongLoc.rowCount);
    const submitterEmployee = submitter.employeeId;
    assert.ok(submitterEmployee);

    const firstEntry = await app.inject({
      method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
      payload: {
        employeeId: submitterEmployee, orderStageId: wipStage.id, stageId: wipStage.stage_id,
        productId: wipStage.output_product_id, shiftId: shift.rows[0].id, workDate: "2099-01-02",
        quantity: 10, warehouseId: wrongWarehouse.rows[0].id, locationId: wrongLoc.rows[0].id,
        responsibleName: "Integration responsible"
      }
    });
    assert.equal(firstEntry.statusCode, 201, firstEntry.body);
    const firstId = firstEntry.json().data.id as string;
    const firstDestination = await apiPool.query("SELECT warehouse_id,location_id,earning_amount,total_earning_amount FROM production_entries WHERE id=$1", [firstId]);
    assert.equal(firstDestination.rows[0].warehouse_id, expectedWip.id, "intermediate production must ignore the client-supplied raw material warehouse");
    assert.notEqual(firstDestination.rows[0].warehouse_id, wrongWarehouse.rows[0].id);

    const selfApproval = await app.inject({
      method: "POST", url: "/api/production/" + firstId + "/approve", headers: { cookie: submitter.cookie }
    });
    assert.equal(selfApproval.statusCode, 409, selfApproval.body);
    assert.equal(selfApproval.json().error.code, "SELF_APPROVAL");

    const approveFirst = await app.inject({
      method: "POST", url: "/api/production/" + firstId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(approveFirst.statusCode, 200, approveFirst.body);
    const wipBalance = await apiPool.query(
      "SELECT quantity,inventory_value,avg_unit_cost FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [wipStage.output_product_id, expectedWip.id, firstDestination.rows[0].location_id]
    );
    assert.equal(Number(wipBalance.rows[0].quantity), 10);
    assert.equal(Number(wipBalance.rows[0].inventory_value), 200);
    const wipMovements = await apiPool.query(
      "SELECT movement_type,quantity,total_cost,order_id,order_stage_id FROM stock_movements WHERE reference_type='PRODUCTION' AND reference_id=$1",
      [firstId]
    );
    assert.equal(wipMovements.rowCount, 1);
    assert.equal(wipMovements.rows[0].movement_type, "IN");
    assert.equal(Number(wipMovements.rows[0].total_cost), 200);
    assert.equal(wipMovements.rows[0].order_id, orderId);
    assert.equal(wipMovements.rows[0].order_stage_id, wipStage.id);
    const lot = await apiPool.query(
      "SELECT original_quantity,remaining_quantity,unit_cost,source_type,source_id FROM inventory_lots WHERE source_type='PRODUCTION' AND source_id=$1",
      [firstId]
    );
    assert.equal(lot.rowCount, 1);
    assert.equal(Number(lot.rows[0].original_quantity), 10);
    assert.equal(Number(lot.rows[0].remaining_quantity), 10);
    assert.equal(Number(lot.rows[0].unit_cost), 20);

    const finalEntry = await app.inject({
      method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
      payload: {
        employeeId: submitterEmployee, orderStageId: finalStage.id, stageId: finalStage.stage_id,
        productId: finalStage.output_product_id, shiftId: shift.rows[0].id, workDate: "2099-01-03",
        quantity: 10, warehouseId: expectedWip.id,
        bonusAmount: 10, bonusReason: "test bonus", deductionAmount: 5, deductionReason: "test deduction"
      }
    });
    assert.equal(finalEntry.statusCode, 201, finalEntry.body);
    const finalId = finalEntry.json().data.id as string;
    const finalSaved = await apiPool.query(
      "SELECT warehouse_id,location_id,earning_amount,bonus_amount,deduction_amount,total_earning_amount FROM production_entries WHERE id=$1",
      [finalId]
    );
    assert.equal(finalSaved.rows[0].warehouse_id, expectedFinished.id, "final stage must always use finished-goods warehouse");
    assert.equal(Number(finalSaved.rows[0].earning_amount), 300);
    assert.equal(Number(finalSaved.rows[0].bonus_amount), 10);
    assert.equal(Number(finalSaved.rows[0].deduction_amount), 5);
    assert.equal(Number(finalSaved.rows[0].total_earning_amount), 305);

    const approveFinal = await app.inject({
      method: "POST", url: "/api/production/" + finalId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(approveFinal.statusCode, 200, approveFinal.body);

    const finalBalance = await apiPool.query(
      "SELECT quantity,inventory_value,avg_unit_cost FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(Number(finalBalance.rows[0].quantity), 10);
    assert.equal(Number(finalBalance.rows[0].inventory_value), 305);
    assert.equal(Number(finalBalance.rows[0].avg_unit_cost), 30.5);

    const ledger = await apiPool.query(
      "SELECT entry_type,credit_amount,debit_amount,production_entry_id FROM employee_earnings_ledger WHERE production_entry_id=$1",
      [finalId]
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(Number(ledger.rows[0].credit_amount), 300, "base wage should be credited once; adjustments are separate entries");
    const adjustments = await apiPool.query(
      "SELECT adjustment_type,amount,ledger_id FROM employee_earnings_adjustments WHERE production_entry_id=$1 ORDER BY adjustment_type",
      [finalId]
    );
    assert.equal(adjustments.rows.length, 2);
    assert.ok(adjustments.every((x: {ledger_id:string|null})=>x.ledger_id));
    assert.equal(
      adjustments.reduce((sum: number, x: {adjustment_type:string;amount:string})=>sum+(x.adjustment_type==="BONUS"?Number(x.amount):-Number(x.amount)),0),
      5
    );

    const stageState = await apiPool.query(
      "SELECT os.completed_quantity,os.status,po.status AS order_status FROM order_stages os JOIN production_orders po ON po.id=os.order_id WHERE os.id=$1",
      [finalStage.id]
    );
    assert.equal(Number(stageState.rows[0].completed_quantity), 10);
    assert.equal(stageState.rows[0].status, "COMPLETED");
    assert.equal(stageState.rows[0].order_status, "COMPLETED");

    const dashboard = await app.inject({
      method: "GET", url: "/api/orders/" + orderId + "/dashboard", headers: { cookie: submitter.cookie }
    });
    assert.equal(dashboard.statusCode, 200, dashboard.body);
    assert.equal(dashboard.json().data.stages.length, 2);
    assert.equal(dashboard.json().data.production.length, 2);
    assert.equal(dashboard.json().data.movements.length, 2);
    assert.equal(Number(dashboard.json().data.totals.production_cost), 505);
    assert.equal(Number(dashboard.json().data.totals.stock_in_cost), 505);

    const profitability = await app.inject({
      method: "GET", url: "/api/accounting/orders/" + orderId + "/profitability", headers: { cookie: submitter.cookie }
    });
    assert.equal(profitability.statusCode, 200, profitability.body);
    assert.equal(Number(profitability.json().data.laborCost), 505);
    assert.equal(Number(profitability.json().data.materialCost), 0);

    const duplicateApproval = await app.inject({
      method: "POST", url: "/api/production/" + finalId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(duplicateApproval.statusCode, 409, duplicateApproval.body);
    const movementCount = await apiPool.query("SELECT COUNT(*)::int AS count FROM stock_movements WHERE reference_type='PRODUCTION' AND reference_id=$1",[finalId]);
    assert.equal(movementCount.rows[0].count, 1, "re-approval must not duplicate stock movements");
  } finally {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    try {
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
