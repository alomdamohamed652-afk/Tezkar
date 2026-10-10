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
      { orderRoutes }, { warehouseRoutes }, { cartonDeliveryRoutes }, { shiftWithdrawalRoutes }, { accountingRoutes }, { reportsRoutes }, { hashPassword },
      poolModule
    ] = await Promise.all([
      import("fastify"), import("@fastify/cookie"), import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/production/production.routes.js"), import("../src/modules/orders/orders.routes.js"),
      import("../src/modules/warehouse/warehouse.routes.js"), import("../src/modules/warehouse/cartons-deliveries.routes.js"), import("../src/modules/warehouse/shift-withdrawals.routes.js"),
      import("../src/modules/accounting/accounting.routes.js"), import("../src/modules/reports/reports.routes.js"), import("../src/modules/auth/auth.service.js"), import("../src/db/pool.js")
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
    await app.register(cartonDeliveryRoutes);
    await app.register(shiftWithdrawalRoutes);
    await app.register(accountingRoutes);
    await app.register(reportsRoutes);

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
    const limitedUser = await makeUser("limited", false);
    await apiPool.query("DELETE FROM user_roles WHERE user_id=$1", [limitedUser.userId]);
    const unauthenticatedCartons = await app.inject({ method: "GET", url: "/api/warehouse/cartons" });
    assert.equal(unauthenticatedCartons.statusCode, 401, unauthenticatedCartons.body);
    const forbiddenCartons = await app.inject({
      method: "GET", url: "/api/warehouse/cartons", headers: { cookie: limitedUser.cookie }
    });
    assert.equal(forbiddenCartons.statusCode, 403, forbiddenCartons.body);
    assert.equal(forbiddenCartons.json().error.code, "FORBIDDEN");
    const forbiddenDelivery = await app.inject({
      method: "POST", url: "/api/delivery-permissions", headers: { cookie: limitedUser.cookie },
      payload: { orderId: "00000000-0000-4000-8000-000000000001", destination: "No permission", lines: [] }
    });
    assert.equal(forbiddenDelivery.statusCode, 403, forbiddenDelivery.body);
    const shift = await apiPool.query(
      "SELECT id,rate_group_id FROM shifts WHERE is_active=TRUE AND rate_group_id IS NOT NULL ORDER BY created_at,id LIMIT 1"
    );
    assert.ok(shift.rowCount, "migrations must seed an active shift and rate group");
    await apiPool.query(
      "INSERT INTO shift_employees(shift_id,employee_id,starts_on,is_active) VALUES($1,$2,'2099-01-01',TRUE) ON CONFLICT(shift_id,employee_id) DO UPDATE SET starts_on=EXCLUDED.starts_on,ends_on=NULL,is_active=TRUE",
      [shift.rows[0].id, submitter.employeeId]
    );

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
        quantity: 10, warehouseId: wrongWarehouse.rows[0].id,
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

    // Consume an intermediate-stage product as an input to the final stage.
    // This intentionally differs from the final stage's output product.
    const withdrawal = await app.inject({
      method: "POST", url: "/api/shift-withdrawals", headers: { cookie: submitter.cookie },
      payload: {
        shiftId: shift.rows[0].id, employeeId: submitterEmployee, withdrawalDate: "2099-01-03",
        orderId, orderStageId: finalStage.id, notes: "Consume WIP input on final stage",
        lines: [{ productId: wipStage.output_product_id, warehouseId: expectedWip.id, quantity: 5, notes: "WIP component input" }]
      }
    });
    assert.equal(withdrawal.statusCode, 201, withdrawal.body);
    const consumedWip = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [wipStage.output_product_id, expectedWip.id, firstDestination.rows[0].location_id]
    );
    assert.equal(Number(consumedWip.rows[0].quantity), 5);
    assert.equal(Number(consumedWip.rows[0].inventory_value), 100);
    const consumedMovement = await apiPool.query(
      "SELECT movement_type,quantity,total_cost,order_id,order_stage_id FROM stock_movements WHERE reference_type='SHIFT_WITHDRAWAL' AND order_stage_id=$1",
      [finalStage.id]
    );
    assert.equal(consumedMovement.rowCount, 1);
    assert.equal(consumedMovement.rows[0].movement_type, "OUT");
    assert.equal(Number(consumedMovement.rows[0].quantity), 5);
    assert.equal(Number(consumedMovement.rows[0].total_cost), 100);
    assert.equal(consumedMovement.rows[0].order_id, orderId);

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
      "SELECT warehouse_id,location_id,rate_id,earning_amount,bonus_amount,deduction_amount,total_earning_amount FROM production_entries WHERE id=$1",
      [finalId]
    );
    assert.equal(finalSaved.rows[0].warehouse_id, expectedFinished.id, "final stage must always use finished-goods warehouse");
    assert.equal(finalSaved.rows[0].rate_id, null, "order-stage pricing must not require a synthetic global rate row");
    assert.equal(Number(finalSaved.rows[0].earning_amount), 300);
    assert.equal(Number(finalSaved.rows[0].bonus_amount), 10);
    assert.equal(Number(finalSaved.rows[0].deduction_amount), 5);
    assert.equal(Number(finalSaved.rows[0].total_earning_amount), 305);

    // A production-percentage advance is recovered from approved production only,
    // capped at the outstanding balance and linked to the source production entry.
    const percentageAdvance = await apiPool.query(
      `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,production_percentage,repayment_status)
       VALUES($1,100,'Production percentage integration test','PAID',$2,$3,'2099-01-01T12:00:00Z','PRODUCTION_PERCENTAGE',20,'OPEN')
       RETURNING id`,
      [submitterEmployee,submitter.userId,approver.userId]
    );
    const approveFinal = await app.inject({
      method: "POST", url: "/api/production/" + finalId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(approveFinal.statusCode, 200, approveFinal.body);
    const productionRepayment = await apiPool.query(
      "SELECT amount,repayment_type,source_production_entry_id FROM advance_repayments WHERE advance_id=$1",
      [percentageAdvance.rows[0].id]
    );
    assert.equal(productionRepayment.rowCount, 1);
    assert.equal(Number(productionRepayment.rows[0].amount), 60, "20% of 300 production earnings must be recovered");
    assert.equal(productionRepayment.rows[0].repayment_type, "PRODUCTION_PERCENTAGE");
    assert.equal(productionRepayment.rows[0].source_production_entry_id, finalId);
    const remainingAdvance = await apiPool.query(
      "SELECT repayment_status,amount-(SELECT COALESCE(SUM(ar.amount),0) FROM advance_repayments ar WHERE ar.advance_id=advance_requests.id) AS remaining FROM advance_requests WHERE id=$1",
      [percentageAdvance.rows[0].id]
    );
    assert.equal(remainingAdvance.rows[0].repayment_status, "OPEN");
    assert.equal(Number(remainingAdvance.rows[0].remaining), 40);
    const repaymentLedger = await apiPool.query(
      "SELECT debit_amount,notes FROM employee_earnings_ledger WHERE entry_type='ADJUSTMENT' AND notes LIKE $1",
      [`%سداد سلفة ${(await apiPool.query("SELECT code FROM advance_requests WHERE id=$1",[percentageAdvance.rows[0].id])).rows[0].code}%`]
    );
    assert.equal(repaymentLedger.rowCount, 1);
    assert.equal(Number(repaymentLedger.rows[0].debit_amount), 60);

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
    assert.ok(adjustments.rows.every((x: {ledger_id:string|null})=>x.ledger_id));
    assert.equal(
      adjustments.rows.reduce((sum: number, x: {adjustment_type:string;amount:string})=>sum+(x.adjustment_type==="BONUS"?Number(x.amount):-Number(x.amount)),0),
      5
    );

    // Regression: production reports must show the adjusted earning total, not the base wage.
    const productionReport = await app.inject({
      method: "GET", url: "/api/reports/production?from=2099-01-03&to=2099-01-03",
      headers: { cookie: submitter.cookie }
    });
    assert.equal(productionReport.statusCode, 200, productionReport.body);
    const finalProductionCode = (await apiPool.query("SELECT code FROM production_entries WHERE id=$1", [finalId])).rows[0].code as string;
    const reportedEntry = productionReport.json().data.find((row: {production_code:string;earning_amount:string|number}) => row.production_code === finalProductionCode);
    assert.ok(reportedEntry, "approved production entry should appear in the production report");
    assert.equal(Number(reportedEntry.earning_amount), 305, "production report must include bonus and deduction in total earnings");

    // Employee earnings report must reconcile with base production pay and its adjustments.
    const employeeEarningsReport = await app.inject({
      method: "GET", url: "/api/reports/employee-earnings", headers: { cookie: submitter.cookie }
    });
    assert.equal(employeeEarningsReport.statusCode, 200, employeeEarningsReport.body);
    const reportedEmployee = employeeEarningsReport.json().data.find(
      (row: {full_name:string;earned:string|number;debited:string|number;balance:string|number}) =>
        row.full_name === "submitter Employee"
    );
    assert.ok(reportedEmployee, "active employee should appear in earnings report");
    assert.equal(Number(reportedEmployee.earned), 510, "employee earnings report must include base wages and bonus");
    assert.equal(Number(reportedEmployee.debited), 65, "employee earnings report must include production deductions and advance recovery");
    assert.equal(Number(reportedEmployee.balance), 445, "employee earnings balance must reconcile after automatic advance recovery");

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
    assert.equal(dashboard.json().data.movements.length, 1, "order withdrawals must show only actual OUT movements, not production receipts");
    assert.equal(Number(dashboard.json().data.totals.production_cost), 505);
    assert.equal(dashboard.json().data.totals.stock_in_cost, undefined, "production receipt value must not be presented as an order withdrawal cost");
    assert.equal(Number(dashboard.json().data.totals.stock_out_cost), 100);

    const profitability = await app.inject({
      method: "GET", url: "/api/accounting/orders/" + orderId + "/profitability", headers: { cookie: submitter.cookie }
    });
    assert.equal(profitability.statusCode, 200, profitability.body);
    assert.equal(Number(profitability.json().data.laborCost), 505);
    assert.equal(Number(profitability.json().data.materialCost), 100);

    // Availability is a read-only diagnostic: it must explain production and location stock separately.
    const availabilityUrl = "/api/delivery-permissions/availability?orderId=" + orderId
      + "&productId=" + finalStage.output_product_id
      + "&warehouseId=" + expectedFinished.id
      + "&locationId=" + finalSaved.rows[0].location_id;
    const initialAvailability = await app.inject({
      method: "GET", url: availabilityUrl, headers: { cookie: approver.cookie }
    });
    assert.equal(initialAvailability.statusCode, 200, initialAvailability.body);
    assert.equal(Number(initialAvailability.json().data.approvedProduction), 10);
    assert.equal(Number(initialAvailability.json().data.reservedDelivery), 0);
    assert.equal(Number(initialAvailability.json().data.productionAvailable), 10);
    assert.equal(Number(initialAvailability.json().data.stockAvailable), 10);

    // Complete the production -> delivery workflow in this disposable database.
    const deliveryPermission = await app.inject({
      method: "POST", url: "/api/delivery-permissions", headers: { cookie: approver.cookie },
      payload: {
        orderId, destination: "Integration test destination",
        lines: [{ productId: finalStage.output_product_id, warehouseId: expectedFinished.id,
          locationId: finalSaved.rows[0].location_id, quantity: 4 }]
      }
    });
    assert.equal(deliveryPermission.statusCode, 201, deliveryPermission.body);
    const deliveryId = deliveryPermission.json().data.id as string;
    const deliveryCode = deliveryPermission.json().data.code as string;

    const availabilityAfterReservation = await app.inject({
      method: "GET", url: availabilityUrl, headers: { cookie: approver.cookie }
    });
    assert.equal(availabilityAfterReservation.statusCode, 200, availabilityAfterReservation.body);
    assert.equal(Number(availabilityAfterReservation.json().data.reservedDelivery), 4);
    assert.equal(Number(availabilityAfterReservation.json().data.productionAvailable), 6);
    assert.equal(Number(availabilityAfterReservation.json().data.stockReserved), 4);
    assert.equal(Number(availabilityAfterReservation.json().data.stockAvailable), 6);

    const overDelivery = await app.inject({
      method: "POST", url: "/api/delivery-permissions", headers: { cookie: approver.cookie },
      payload: {
        orderId, destination: "Over-delivery must be rejected",
        lines: [{ productId: finalStage.output_product_id, warehouseId: expectedFinished.id,
          locationId: finalSaved.rows[0].location_id, quantity: 7 }]
      }
    });
    assert.equal(overDelivery.statusCode, 409, overDelivery.body);
    assert.equal(overDelivery.json().error.code, "DELIVERY_EXCEEDS_PRODUCTION");

    const wrongScan = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + deliveryId + "/release",
      headers: { cookie: approver.cookie }, payload: { scanCode: "WRONG-SCAN-CODE" }
    });
    assert.equal(wrongScan.statusCode, 409, wrongScan.body);
    assert.equal(wrongScan.json().error.code, "SCAN_MISMATCH");

    const release = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + deliveryId + "/release",
      headers: { cookie: approver.cookie }, payload: { scanCode: deliveryCode }
    });
    assert.equal(release.statusCode, 200, release.body);
    assert.equal(release.json().data.status, "RELEASED");

    const afterDelivery = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(Number(afterDelivery.rows[0].quantity), 6);
    assert.equal(Number(afterDelivery.rows[0].inventory_value), 183);
    const deliveryMovement = await apiPool.query(
      "SELECT movement_type,quantity,reference_type,reference_id,order_id FROM stock_movements WHERE reference_type='DELIVERY' AND reference_id=$1",
      [deliveryId]
    );
    assert.equal(deliveryMovement.rowCount, 1);
    assert.equal(deliveryMovement.rows[0].movement_type, "OUT");
    assert.equal(Number(deliveryMovement.rows[0].quantity), 4);
    assert.equal(deliveryMovement.rows[0].order_id, orderId);

    const duplicateRelease = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + deliveryId + "/release",
      headers: { cookie: approver.cookie }, payload: { scanCode: deliveryCode }
    });
    assert.equal(duplicateRelease.statusCode, 409, duplicateRelease.body);
    assert.equal(duplicateRelease.json().error.code, "INVALID_STATUS");
    const deliveryMovementCount = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM stock_movements WHERE reference_type='DELIVERY' AND reference_id=$1",
      [deliveryId]
    );
    assert.equal(deliveryMovementCount.rows[0].count, 1, "releasing twice must not duplicate delivery stock movements");

    // Verify carton labeling, barcode resolution, partial-carton balance and stock release.
    const cartonResponse = await app.inject({
      method: "POST", url: "/api/warehouse/cartons", headers: { cookie: approver.cookie },
      payload: {
        productId: finalStage.output_product_id, warehouseId: expectedFinished.id,
        locationId: finalSaved.rows[0].location_id, quantity: 3, weight: 1.2,
        batchCode: "INTEGRATION-BATCH", status: "SEALED"
      }
    });
    assert.equal(cartonResponse.statusCode, 201, cartonResponse.body);
    const carton = cartonResponse.json().data;
    assert.ok(carton.barcode, "cartons without a supplied barcode must receive a generated barcode");
    assert.equal(carton.status, "SEALED");
    assert.equal(Number(carton.quantity), 3);

    const cartonDelivery = await app.inject({
      method: "POST", url: "/api/delivery-permissions", headers: { cookie: approver.cookie },
      payload: {
        orderId, destination: "Integration carton delivery",
        lines: [{ productId: finalStage.output_product_id, warehouseId: expectedFinished.id,
          locationId: finalSaved.rows[0].location_id, quantity: 2, cartonCode: carton.barcode }]
      }
    });
    assert.equal(cartonDelivery.statusCode, 201, cartonDelivery.body);
    const cartonDeliveryId = cartonDelivery.json().data.id as string;
    const cartonDeliveryCode = cartonDelivery.json().data.code as string;
    const cartonRelease = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + cartonDeliveryId + "/release",
      headers: { cookie: approver.cookie }, payload: { scanCode: cartonDeliveryCode }
    });
    assert.equal(cartonRelease.statusCode, 200, cartonRelease.body);
    assert.equal(cartonRelease.json().data.status, "RELEASED");

    const cartonAfterRelease = await apiPool.query(
      "SELECT quantity,status,barcode FROM cartons WHERE id=$1", [carton.id]
    );
    assert.equal(Number(cartonAfterRelease.rows[0].quantity), 1, "partial carton release must preserve the remaining quantity");
    assert.equal(cartonAfterRelease.rows[0].status, "PARTIAL");
    assert.equal(cartonAfterRelease.rows[0].barcode, carton.barcode);
    const cartonMovement = await apiPool.query(
      "SELECT movement_type,quantity,carton_code,reference_id FROM stock_movements WHERE reference_type='DELIVERY' AND reference_id=$1",
      [cartonDeliveryId]
    );
    assert.equal(cartonMovement.rowCount, 1);
    assert.equal(cartonMovement.rows[0].movement_type, "OUT");
    assert.equal(Number(cartonMovement.rows[0].quantity), 2);
    assert.equal(cartonMovement.rows[0].carton_code, carton.barcode);
    const stockAfterCartonDelivery = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(Number(stockAfterCartonDelivery.rows[0].quantity), 4);
    assert.equal(Number(stockAfterCartonDelivery.rows[0].inventory_value), 122);

    // Verify order-linked revenue and expense feed the profitability report.
    const revenue = await app.inject({
      method: "POST", url: "/api/accounting/revenues", headers: { cookie: approver.cookie },
      payload: { orderId, amount: 1000, revenueDate: "2099-01-06", source: "TEST", notes: "Isolated workflow test" }
    });
    assert.equal(revenue.statusCode, 201, revenue.body);
    assert.equal(revenue.json().data.order_id, orderId);
    const expense = await app.inject({
      method: "POST", url: "/api/accounting/expenses", headers: { cookie: approver.cookie },
      payload: { orderId, category: "TEST", description: "Isolated workflow test expense", amount: 50, expenseDate: "2099-01-06", paymentMethod: "TEST" }
    });
    assert.equal(expense.statusCode, 201, expense.body);
    assert.equal(expense.json().data.order_id, orderId);

    const finalProfitability = await app.inject({
      method: "GET", url: "/api/accounting/orders/" + orderId + "/profitability", headers: { cookie: submitter.cookie }
    });
    assert.equal(finalProfitability.statusCode, 200, finalProfitability.body);
    assert.equal(Number(finalProfitability.json().data.revenue), 1000);
    assert.equal(Number(finalProfitability.json().data.expenses), 50);
    assert.equal(Number(finalProfitability.json().data.materialCost), 100);
    assert.equal(Number(finalProfitability.json().data.laborCost), 505);
    assert.equal(Number(finalProfitability.json().data.totalCost), 655);
    assert.equal(Number(finalProfitability.json().data.profit), 345);
    assert.equal(Number(finalProfitability.json().data.marginPercent), 34.5);

    const accountingSummary = await app.inject({
      method: "GET", url: "/api/accounting/summary", headers: { cookie: submitter.cookie }
    });
    assert.equal(accountingSummary.statusCode, 200, accountingSummary.body);
    assert.equal(Number(accountingSummary.json().data.total_in), 1000);
    assert.equal(Number(accountingSummary.json().data.total_out), 50);
    assert.equal(Number(accountingSummary.json().data.net), 950);

    const duplicateApproval = await app.inject({
      method: "POST", url: "/api/production/" + finalId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(duplicateApproval.statusCode, 409, duplicateApproval.body);
    const deleteApprovedProduction = await app.inject({
      method: "DELETE", url: "/api/production/" + finalId, headers: { cookie: approver.cookie },
      payload: { password: "Test-only-password-2026!" }
    });
    assert.equal(deleteApprovedProduction.statusCode, 409, deleteApprovedProduction.body);
    assert.equal(deleteApprovedProduction.json().error.code, "PRODUCTION_DELETE_LOCKED",
      "approved production must not be removed without reversing stock and earnings");
    const movementCount = await apiPool.query("SELECT COUNT(*)::int AS count FROM stock_movements WHERE reference_type='PRODUCTION' AND reference_id=$1",[finalId]);
    assert.equal(movementCount.rows[0].count, 1, "re-approval must not duplicate stock movements");

    // Regression: two approvals for the same product when no balance row exists
    // must serialize and preserve both quantities and values.
    const concurrentOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: {
        orderName: "Concurrent stock integration order",
        orderDate: "2099-01-04",
        stages: [
          { stageName: "Concurrent stock stage", sequenceNo: 1, outputProductName: "Concurrent stock product", plannedQuantity: 10, stageRate: 20, stageRateMethod: "PER_PIECE" }
        ]
      }
    });
    assert.equal(concurrentOrder.statusCode, 201, concurrentOrder.body);
    const concurrentOrderId = concurrentOrder.json().data.id as string;
    const concurrentStage = await apiPool.query(
      "SELECT os.id,os.stage_id,os.output_product_id FROM order_stages os WHERE os.order_id=$1",
      [concurrentOrderId]
    );
    const concurrentProductId = concurrentStage.rows[0].output_product_id as string;
    const concurrentEntries = await Promise.all([4, 6].map(async (quantity, index) => {
      const response = await app!.inject({
        method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
        payload: {
          employeeId: submitterEmployee, orderStageId: concurrentStage.rows[0].id,
          stageId: concurrentStage.rows[0].stage_id, productId: concurrentProductId,
          shiftId: shift.rows[0].id, workDate: index === 0 ? "2099-01-04" : "2099-01-05",
          quantity, warehouseId: expectedFinished.id
        }
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().data.id as string;
    }));
    const simultaneousApprovals = await Promise.all(concurrentEntries.map(id =>
      app!.inject({ method: "POST", url: "/api/production/" + id + "/approve", headers: { cookie: approver.cookie } })
    ));
    assert.ok(simultaneousApprovals.every(response => response.statusCode === 200),
      simultaneousApprovals.map(response => `${response.statusCode}: ${response.body}`).join("\\n"));
    const concurrentLocation = await apiPool.query(
      "SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",
      [expectedFinished.id]
    );
    const concurrentBalance = await apiPool.query(
      "SELECT quantity,inventory_value,avg_unit_cost FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [concurrentProductId, expectedFinished.id, concurrentLocation.rows[0].id]
    );
    assert.equal(Number(concurrentBalance.rows[0].quantity), 10);
    assert.equal(Number(concurrentBalance.rows[0].inventory_value), 200);
    assert.equal(Number(concurrentBalance.rows[0].avg_unit_cost), 20);
    const concurrentMovementCount = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM stock_movements WHERE reference_type='PRODUCTION' AND reference_id=ANY($1::uuid[])",
      [concurrentEntries]
    );
    assert.equal(concurrentMovementCount.rows[0].count, 2);
    const concurrentLotCount = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM inventory_lots WHERE source_type='PRODUCTION' AND source_id=ANY($1::uuid[])",
      [concurrentEntries]
    );
    assert.equal(concurrentLotCount.rows[0].count, 2);

    // Password-confirmed order cancellation must reject an incorrect password.
    const deletableOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: { orderName: "Password delete test order", orderDate: "2099-01-06",
        stages: [{ stageName: "Password delete stage", sequenceNo: 1, outputProductName: "Password delete product", plannedQuantity: 1, stageRate: 1, stageRateMethod: "PER_PIECE" }] }
    });
    assert.equal(deletableOrder.statusCode, 201, deletableOrder.body);
    const deletableOrderId = deletableOrder.json().data.id as string;
    const wrongOrderPassword = await app.inject({
      method: "DELETE", url: "/api/orders/" + deletableOrderId, headers: { cookie: submitter.cookie },
      payload: { password: "not-the-password" }
    });
    assert.equal(wrongOrderPassword.statusCode, 401, wrongOrderPassword.body);
    const deleteOrder = await app.inject({
      method: "DELETE", url: "/api/orders/" + deletableOrderId, headers: { cookie: submitter.cookie },
      payload: { password: "Test-only-password-2026!" }
    });
    assert.equal(deleteOrder.statusCode, 200, deleteOrder.body);
    assert.equal(deleteOrder.json().data.status, "CANCELLED");
    const visibleOrders = await app.inject({ method: "GET", url: "/api/orders", headers: { cookie: submitter.cookie } });
    assert.ok(!visibleOrders.json().data.some((x: {id:string}) => x.id === deletableOrderId), "cancelled orders must be hidden from the default list");

    // A pending production row can be cancelled only after password confirmation.
    const pendingOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: { orderName: "Pending production delete test", orderDate: "2099-01-07",
        stages: [{ stageName: "Pending delete stage", sequenceNo: 1, outputProductName: "Pending delete product", plannedQuantity: 2, stageRate: 1, stageRateMethod: "PER_PIECE" }] }
    });
    assert.equal(pendingOrder.statusCode, 201, pendingOrder.body);
    const pendingOrderId = pendingOrder.json().data.id as string;
    const pendingStage = await apiPool.query("SELECT os.id,os.stage_id,os.output_product_id FROM order_stages os WHERE os.order_id=$1",[pendingOrderId]);
    const pendingProduction = await app.inject({
      method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
      payload: { employeeId: submitterEmployee, orderStageId: pendingStage.rows[0].id,
        stageId: pendingStage.rows[0].stage_id, productId: pendingStage.rows[0].output_product_id,
        shiftId: shift.rows[0].id, workDate: "2099-01-07", quantity: 1 }
    });
    assert.equal(pendingProduction.statusCode, 201, pendingProduction.body);
    const pendingProductionId = pendingProduction.json().data.id as string;
    const wrongProductionPassword = await app.inject({
      method: "DELETE", url: "/api/production/" + pendingProductionId, headers: { cookie: submitter.cookie },
      payload: { password: "not-the-password" }
    });
    assert.equal(wrongProductionPassword.statusCode, 401, wrongProductionPassword.body);
    const deleteProduction = await app.inject({
      method: "DELETE", url: "/api/production/" + pendingProductionId, headers: { cookie: submitter.cookie },
      payload: { password: "Test-only-password-2026!" }
    });
    assert.equal(deleteProduction.statusCode, 200, deleteProduction.body);
    assert.equal(deleteProduction.json().data.status, "CANCELLED");
    const activeProduction = await app.inject({ method: "GET", url: "/api/production", headers: { cookie: submitter.cookie } });
    assert.ok(!activeProduction.json().data.some((x: {id:string}) => x.id === pendingProductionId), "cancelled production must be hidden from the default list");
    
    // Verify all three price scopes: new-only leaves old operations untouched,
    // unpaid-only updates only operations with no payment allocation recorded, and ALL posts
    // separate auditable ledger adjustments without rewriting approved snapshots.
    const priceOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: { orderName: "Price change integration order", orderDate: "2099-01-08",
        stages: [{ stageName: "Price change stage", sequenceNo: 1, outputProductName: "Price change product", plannedQuantity: 20, stageRate: 20, stageRateMethod: "PER_PIECE" }] }
    });
    assert.equal(priceOrder.statusCode, 201, priceOrder.body);
    const priceOrderId = priceOrder.json().data.id as string;
    const priceStage = await apiPool.query(
      "SELECT os.id,os.stage_id,os.output_product_id,os.stage_rate FROM order_stages os WHERE os.order_id=$1",
      [priceOrderId]
    );
    const priceProduction = await app.inject({
      method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
      payload: { employeeId: submitterEmployee, orderStageId: priceStage.rows[0].id,
        stageId: priceStage.rows[0].stage_id, productId: priceStage.rows[0].output_product_id,
        shiftId: shift.rows[0].id, workDate: "2099-01-08", quantity: 10 }
    });
    assert.equal(priceProduction.statusCode, 201, priceProduction.body);
    const priceProductionId = priceProduction.json().data.id as string;
    const approvedPriceProduction = await app.inject({
      method: "POST", url: "/api/production/" + priceProductionId + "/approve",
      headers: { cookie: approver.cookie }
    });
    assert.equal(approvedPriceProduction.statusCode, 200, approvedPriceProduction.body);
    const originalPriceEarning = await apiPool.query(
      "SELECT earning_amount FROM production_entries WHERE id=$1", [priceProductionId]
    );
    assert.equal(Number(originalPriceEarning.rows[0].earning_amount), 200);

    const newOnlyChange = await app.inject({
      method: "POST", url: "/api/orders/" + priceOrderId + "/price-changes",
      headers: { cookie: submitter.cookie },
      payload: { orderStageId: priceStage.rows[0].id, newRate: 22, scope: "NEW_ONLY", reason: "Integration new-only price" }
    });
    assert.equal(newOnlyChange.statusCode, 201, newOnlyChange.body);
    assert.equal(newOnlyChange.json().data.affected_entries, 0);
    const oldEntryAfterNewOnly = await apiPool.query("SELECT earning_amount FROM production_entries WHERE id=$1", [priceProductionId]);
    assert.equal(Number(oldEntryAfterNewOnly.rows[0].earning_amount), 200, "new-only price changes must not rewrite existing production");
    const newOnlyStageRate = await apiPool.query("SELECT stage_rate FROM order_stages WHERE id=$1", [priceStage.rows[0].id]);
    assert.equal(Number(newOnlyStageRate.rows[0].stage_rate), 22);

    const secondPriceProduction = await app.inject({
      method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
      payload: { employeeId: submitterEmployee, orderStageId: priceStage.rows[0].id,
        stageId: priceStage.rows[0].stage_id, productId: priceStage.rows[0].output_product_id,
        shiftId: shift.rows[0].id, workDate: "2099-01-09", quantity: 10 }
    });
    assert.equal(secondPriceProduction.statusCode, 201, secondPriceProduction.body);
    const secondPriceProductionId = secondPriceProduction.json().data.id as string;
    const secondApproved = await app.inject({
      method: "POST", url: "/api/production/" + secondPriceProductionId + "/approve",
      headers: { cookie: approver.cookie }
    });
    assert.equal(secondApproved.statusCode, 200, secondApproved.body);
    const secondOriginalEarning = await apiPool.query("SELECT earning_amount FROM production_entries WHERE id=$1", [secondPriceProductionId]);
    assert.equal(Number(secondOriginalEarning.rows[0].earning_amount), 220, "new production must use the new stage price");

    const unpaidOnlyChange = await app.inject({
      method: "POST", url: "/api/orders/" + priceOrderId + "/price-changes",
      headers: { cookie: submitter.cookie },
      payload: { orderStageId: priceStage.rows[0].id, newRate: 25, scope: "UNPAID_ONLY", reason: "Integration unpaid price" }
    });
    assert.equal(unpaidOnlyChange.statusCode, 201, unpaidOnlyChange.body);
    assert.equal(unpaidOnlyChange.json().data.affected_entries, 2);
    assert.equal(Number(unpaidOnlyChange.json().data.total_delta), 80);
    const unpaidCredits = await apiPool.query(
      "SELECT COALESCE(SUM(credit_amount),0) AS credits,COALESCE(SUM(debit_amount),0) AS debits FROM employee_earnings_ledger WHERE employee_id=$1 AND notes LIKE '%Integration unpaid price%'",
      [submitterEmployee]
    );
    assert.equal(Number(unpaidCredits.rows[0].credits), 80);
    assert.equal(Number(unpaidCredits.rows[0].debits), 0);

    const allChange = await app.inject({
      method: "POST", url: "/api/orders/" + priceOrderId + "/price-changes",
      headers: { cookie: submitter.cookie },
      payload: { orderStageId: priceStage.rows[0].id, newRate: 30, scope: "ALL", reason: "Integration all price" }
    });
    assert.equal(allChange.statusCode, 201, allChange.body);
    assert.equal(allChange.json().data.affected_entries, 2);
    assert.equal(Number(allChange.json().data.total_delta), 100);
    const finalStageRate = await apiPool.query("SELECT stage_rate FROM order_stages WHERE id=$1", [priceStage.rows[0].id]);
    assert.equal(Number(finalStageRate.rows[0].stage_rate), 30);
    const approvedSnapshots = await apiPool.query(
      "SELECT id,earning_amount FROM production_entries WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[priceProductionId,secondPriceProductionId]]
    );
    assert.deepEqual(approvedSnapshots.rows.map((row: {earning_amount:string|number})=>Number(row.earning_amount)).sort((a:number,b:number)=>a-b),[200,220],
      "approved production snapshots must remain unchanged after price changes");
    const allCredits = await apiPool.query(
      "SELECT COALESCE(SUM(credit_amount),0) AS credits,COALESCE(SUM(debit_amount),0) AS debits FROM employee_earnings_ledger WHERE employee_id=$1 AND notes LIKE '%Integration all price%'",
      [submitterEmployee]
    );
    assert.equal(Number(allCredits.rows[0].credits), 100);
    assert.equal(Number(allCredits.rows[0].debits), 0);
    const priceHistory = await app.inject({
      method: "GET", url: "/api/orders/" + priceOrderId + "/price-changes",
      headers: { cookie: submitter.cookie }
    });
    assert.equal(priceHistory.statusCode, 200, priceHistory.body);
    assert.equal(priceHistory.json().data.length, 3);
    assert.equal(priceHistory.json().data[0].reason, "Integration all price");
    assert.equal(Number(priceHistory.json().data[0].affected[0].delta_amount), 50);
    assert.equal(priceHistory.json().data[1].reason, "Integration unpaid price");
    assert.equal(priceHistory.json().data[2].reason, "Integration new-only price");

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
