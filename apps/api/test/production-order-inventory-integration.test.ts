import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
      { default: Fastify }, { default: cookie }, { authRoutes }, { productionRoutes }, { productionScrapRoutes },
      { orderRoutes }, { warehouseRoutes }, { cartonDeliveryRoutes }, { codingRoutes }, { shiftWithdrawalRoutes }, { accountingRoutes }, { reportsRoutes }, { hashPassword },
      poolModule
    ] = await Promise.all([
      import("fastify"), import("@fastify/cookie"), import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/production/production.routes.js"), import("../src/modules/production/production-scrap.routes.js"), import("../src/modules/orders/orders.routes.js"),
      import("../src/modules/warehouse/warehouse.routes.js"), import("../src/modules/warehouse/cartons-deliveries.routes.js"), import("../src/modules/coding/coding.routes.js"), import("../src/modules/warehouse/shift-withdrawals.routes.js"),
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
    await app.register(productionScrapRoutes);
    await app.register(orderRoutes);
    await app.register(warehouseRoutes);
    await app.register(cartonDeliveryRoutes);
    await app.register(codingRoutes);
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
    await apiPool.query(
      "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',1000,'test opening custody for production settlement',$2)",
      [approver.employeeId,approver.userId]
    );
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

    // Arabic hamza, tashkeel, and repeated whitespace must resolve to one existing
    // product/stage even when two order requests arrive at the same time.
    const arabicSuffix = randomBytes(4).toString("hex");
    const arabicRequests = [
      {
        orderName: "Arabic normalization A " + arabicSuffix,
        orderDate: "2099-01-03",
        stages: [{
          stageName: "طباعة UV " + arabicSuffix,
          sequenceNo: 1,
          outputProductName: "مقلمه مطبوعه (انا لها) " + arabicSuffix,
          plannedQuantity: 1,
          stageRate: 1,
          stageRateMethod: "PER_PIECE",
          isFinalProduct: true
        }]
      },
      {
        orderName: "Arabic normalization B " + arabicSuffix,
        orderDate: "2099-01-03",
        stages: [{
          stageName: "طِباعة   UV " + arabicSuffix,
          sequenceNo: 1,
          outputProductName: "مقلمه مطبوعه (ا\u0654َنَا لها) " + arabicSuffix,
          plannedQuantity: 1,
          stageRate: 1,
          stageRateMethod: "PER_PIECE",
          isFinalProduct: true
        }]
      }
    ];
    const arabicOrderResults = await Promise.all(arabicRequests.map(payload => app!.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie }, payload
    })));
    assert.ok(arabicOrderResults.every(result => result.statusCode === 201), arabicOrderResults.map(result => result.body).join("\\n"));
    const arabicOrderIds = arabicOrderResults.map(result => result.json().data.id as string);
    const arabicProducts = await apiPool.query(
      "SELECT order_id,output_product_id,stage_id FROM order_stages WHERE order_id = ANY($1::uuid[]) ORDER BY order_id",
      [arabicOrderIds]
    );
    assert.equal(arabicProducts.rowCount, 2);
    assert.equal(arabicProducts.rows[0].output_product_id, arabicProducts.rows[1].output_product_id,
      "Arabic hamza/tashkeel variants must resolve to the same product");
    assert.equal(arabicProducts.rows[0].stage_id, arabicProducts.rows[1].stage_id,
      "Arabic tashkeel and repeated spaces must resolve to the same stage");

    // One order may contain multiple final products, each designated on its own stage.
    const multiSuffix = randomBytes(4).toString("hex");
    const multiFinalOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: {
        orderName: "Multi final product order " + multiSuffix,
        customerName: "Test-only multi-product customer",
        orderDate: "2099-01-02",
        stages: [
          { stageName: "Multi final prep " + multiSuffix, sequenceNo: 1, outputProductName: "Multi intermediate " + multiSuffix, plannedQuantity: 12, stageRate: 2, stageRateMethod: "PER_PIECE" },
          { stageName: "Multi final A " + multiSuffix, sequenceNo: 2, outputProductName: "Multi final product A " + multiSuffix, isFinalProduct: true, plannedQuantity: 5, stageRate: 3, stageRateMethod: "PER_PIECE" },
          { stageName: "Multi final B " + multiSuffix, sequenceNo: 3, outputProductName: "Multi final product B " + multiSuffix, isFinalProduct: true, plannedQuantity: 7, stageRate: 4, stageRateMethod: "PER_PIECE" }
        ]
      }
    });
    assert.equal(multiFinalOrder.statusCode, 201, multiFinalOrder.body);
    const multiOrderId = multiFinalOrder.json().data.id as string;
    const multiLines = await apiPool.query(
      "SELECT p.name AS product_name,pol.quantity FROM production_order_lines pol JOIN products p ON p.id=pol.product_id WHERE pol.order_id=$1 ORDER BY p.name",
      [multiOrderId]
    );
    assert.equal(multiLines.rowCount, 2, "order lines should include both explicitly selected final products, not the intermediate stage output");
    assert.deepEqual(multiLines.rows.map((line: {product_name:string;quantity:string|number})=>({name:line.product_name,quantity:Number(line.quantity)})), [
      {name:"Multi final product A "+multiSuffix,quantity:5},
      {name:"Multi final product B "+multiSuffix,quantity:7}
    ]);
    const markedFinalStages = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM order_stages WHERE order_id=$1 AND is_final_product=TRUE",
      [multiOrderId]
    );
    assert.equal(markedFinalStages.rows[0].count, 2);

    const orderId = orderResponse.json().data.id as string;

    // Contractual value, recognized revenue, and cancellation guards must agree.
    const contractOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: {
        orderName: "Contract guard integration " + randomBytes(4).toString("hex"),
        customerName: "Contract guard customer", orderDate: "2099-01-04", contractValue: 100,
        stages: [{ stageName: "Contract guard stage", sequenceNo: 1, outputProductName: "Contract guard final product", plannedQuantity: 1, stageRate: 1, stageRateMethod: "PER_PIECE", isFinalProduct: true }]
      }
    });
    assert.equal(contractOrder.statusCode, 201, contractOrder.body);
    const contractOrderId = contractOrder.json().data.id as string;
    const contractRevenuePayload={orderId:contractOrderId,amount:80,revenueDate:"2099-01-04",source:"MANUAL",notes:"Contract guard integration",idempotencyKey:randomUUID()};
    const firstContractRevenue = await app.inject({
      method: "POST", url: "/api/accounting/revenues", headers: { cookie: submitter.cookie },payload:contractRevenuePayload
    });
    assert.equal(firstContractRevenue.statusCode, 201, firstContractRevenue.body);
    const retriedContractRevenue=await app.inject({
      method:"POST",url:"/api/accounting/revenues",headers:{cookie:submitter.cookie},payload:contractRevenuePayload
    });
    assert.equal(retriedContractRevenue.statusCode,201,retriedContractRevenue.body);
    assert.equal(retriedContractRevenue.json().data.id,firstContractRevenue.json().data.id);
    const reusedRevenueKey=await app.inject({
      method:"POST",url:"/api/accounting/revenues",headers:{cookie:submitter.cookie},payload:{...contractRevenuePayload,amount:80.01}
    });
    assert.equal(reusedRevenueKey.statusCode,409,reusedRevenueKey.body);
    assert.equal(reusedRevenueKey.json().error.code,"IDEMPOTENCY_KEY_REUSED");
    const concurrentRevenueOrder=(await apiPool.query(
      "INSERT INTO production_orders(order_name,created_by,status,contract_value) VALUES($1,$2,'DRAFT',10) RETURNING id",
      ["Concurrent revenue idempotency order",submitter.userId]
    )).rows[0];
    const concurrentRevenuePayload={orderId:concurrentRevenueOrder.id,amount:6,revenueDate:"2099-01-04",source:"MANUAL",notes:"Concurrent retry",idempotencyKey:randomUUID()};
    const concurrentRevenueResults=await Promise.all([1,2].map(()=>app.inject({
      method:"POST",url:"/api/accounting/revenues",headers:{cookie:submitter.cookie},payload:concurrentRevenuePayload
    })));
    assert.ok(concurrentRevenueResults.every(x=>x.statusCode===201),concurrentRevenueResults.map(x=>x.body).join("\\n"));
    assert.equal(concurrentRevenueResults[0].json().data.id,concurrentRevenueResults[1].json().data.id);
    const concurrentRevenueCount=await apiPool.query("SELECT COUNT(*)::int AS count FROM order_revenues WHERE idempotency_key=$1",[concurrentRevenuePayload.idempotencyKey]);
    assert.equal(concurrentRevenueCount.rows[0].count,1,"concurrent revenue retries must create exactly one ledger entry");

    const overContractRevenue = await app.inject({
      method: "POST", url: "/api/accounting/revenues", headers: { cookie: submitter.cookie },
      payload: { orderId: contractOrderId, amount: 20.01, revenueDate: "2099-01-04", source: "MANUAL", notes: "Must exceed contract",idempotencyKey:randomUUID() }
    });
    assert.equal(overContractRevenue.statusCode, 409, overContractRevenue.body);
    assert.equal(overContractRevenue.json().error.code, "CONTRACT_VALUE_EXCEEDED");
    const belowRecordedContract = await app.inject({
      method: "PATCH", url: "/api/orders/" + contractOrderId, headers: { cookie: submitter.cookie },
      payload: { contractValue: 79.99 }
    });
    assert.equal(belowRecordedContract.statusCode, 409, belowRecordedContract.body);
    assert.equal(belowRecordedContract.json().error.code, "CONTRACT_VALUE_BELOW_RECORDED_REVENUE");
    const cancelWithRevenue = await app.inject({
      method: "PATCH", url: "/api/orders/" + contractOrderId, headers: { cookie: submitter.cookie },
      payload: { status: "CANCELLED" }
    });
    assert.equal(cancelWithRevenue.statusCode, 409, cancelWithRevenue.body);
    assert.equal(cancelWithRevenue.json().error.code, "ORDER_HAS_ACTIVITY_LOCKED");

    await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1", [orderId]);
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
    const validScrapKey = randomUUID();
    const validScrapPayload = {
      idempotencyKey: validScrapKey, productionEntryId: firstId,
      scrapType: "WORKER_SCRAP", quantity: 1, notes: "Active stage scrap integration"
    };
    const validScrap = await app.inject({
      method: "POST", url: "/api/production/scrap", headers: { cookie: submitter.cookie },
      payload: validScrapPayload
    });
    assert.equal(validScrap.statusCode, 201, validScrap.body);
    assert.equal(Number(validScrap.json().data.quantity), 1);
    const validScrapReplay = await app.inject({
      method: "POST", url: "/api/production/scrap", headers: { cookie: submitter.cookie },
      payload: validScrapPayload
    });
    assert.equal(validScrapReplay.statusCode, 200, validScrapReplay.body);
    assert.equal(validScrapReplay.json().data.stock_movement_id, validScrap.json().data.stock_movement_id,
      "a retried scrap submission must return the original stock movement");
    const reusedScrapKey = await app.inject({
      method: "POST", url: "/api/production/scrap", headers: { cookie: submitter.cookie },
      payload: { ...validScrapPayload, quantity: 2 }
    });
    assert.equal(reusedScrapKey.statusCode, 409, reusedScrapKey.body);
    assert.equal(reusedScrapKey.json().error.code, "IDEMPOTENCY_KEY_REUSED");
    const scrapMovement = await apiPool.query(
      "SELECT movement_type,quantity,total_cost,reference_type,reference_id FROM stock_movements WHERE id=$1",
      [validScrap.json().data.stock_movement_id]
    );
    assert.equal(scrapMovement.rows[0].movement_type, "IN");
    assert.equal(Number(scrapMovement.rows[0].quantity), 1);
    assert.equal(Number(scrapMovement.rows[0].total_cost), 0);
    assert.equal(scrapMovement.rows[0].reference_type, "PRODUCTION_SCRAP");
    assert.equal(scrapMovement.rows[0].reference_id, validScrap.json().data.id);
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
    // The first 10 processed units include 1 scrap, so produce one additional
    // good unit to meet the order's planned quantity of 10.
    const replacementGoodEntry = await app.inject({
      method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
      payload: {
        employeeId: approver.employeeId, orderStageId: wipStage.id,
        productId: wipStage.output_product_id, stageId: wipStage.stage_id,
        shiftId: shift.rows[0].id, workDate: "2099-01-02", quantity: 1,
        warehouseId: wrongWarehouse.rows[0].id, responsibleName: "Replacement good unit"
      }
    });
    assert.equal(replacementGoodEntry.statusCode, 201, replacementGoodEntry.body);
    const replacementGoodId = replacementGoodEntry.json().data.id as string;
    const approveReplacementGood = await app.inject({
      method: "POST", url: "/api/production/" + replacementGoodId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(approveReplacementGood.statusCode, 200, approveReplacementGood.body);
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
    assert.equal(Number(wipMovements.rows[0].total_cost), 180);
    assert.equal(wipMovements.rows[0].order_id, orderId);
    assert.equal(wipMovements.rows[0].order_stage_id, wipStage.id);
    const lot = await apiPool.query(
      "SELECT original_quantity,remaining_quantity,unit_cost,source_type,source_id FROM inventory_lots WHERE source_type='PRODUCTION' AND source_id=$1",
      [firstId]
    );
    assert.equal(lot.rowCount, 1);
    assert.equal(Number(lot.rows[0].original_quantity), 9);
    assert.equal(Number(lot.rows[0].remaining_quantity), 9);
    assert.equal(Number(lot.rows[0].unit_cost), 20);

    // Scrap recorded before approval is excluded from good stock. Scrap recorded
    // after approval must transfer quantity out of good stock, not duplicate it.
    const postApprovalOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: {
        orderName: "Post approval scrap order " + randomBytes(4).toString("hex"),
        orderDate: "2099-01-02",
        stages: [{
          stageName: "Integration WIP stage",
          sequenceNo: 1,
          outputProductName: "Integration component",
          plannedQuantity: 100,
          stageRate: 20,
          stageRateMethod: "PER_PIECE",
          isFinalProduct: true
        }]
      }
    });
    assert.equal(postApprovalOrder.statusCode, 201, postApprovalOrder.body);
    const postApprovalOrderId = postApprovalOrder.json().data.id as string;
    const planPostApprovalOrder = await app.inject({
      method: "PATCH", url: "/api/orders/" + postApprovalOrderId, headers: { cookie: submitter.cookie },
      payload: { status: "PLANNED" }
    });
    assert.equal(planPostApprovalOrder.statusCode, 200, planPostApprovalOrder.body);
    const activatePostApprovalOrder = await app.inject({
      method: "PATCH", url: "/api/orders/" + postApprovalOrderId, headers: { cookie: submitter.cookie },
      payload: { status: "IN_PROGRESS" }
    });
    assert.equal(activatePostApprovalOrder.statusCode, 200, activatePostApprovalOrder.body);
    const postApprovalOrderDetail = await app.inject({
      method: "GET", url: "/api/orders/" + postApprovalOrderId, headers: { cookie: submitter.cookie }
    });
    assert.equal(postApprovalOrderDetail.statusCode, 200, postApprovalOrderDetail.body);
    const postApprovalStage = postApprovalOrderDetail.json().data.stages[0];
    const postApprovalEntry = await app.inject({
      method: "POST", url: "/api/production", headers: { cookie: submitter.cookie },
      payload: {
        employeeId: approver.employeeId, orderStageId: postApprovalStage.id,
        productId: postApprovalStage.output_product_id, stageId: postApprovalStage.stage_id,
        shiftId: shift.rows[0].id, workDate: "2099-01-02", quantity: 3,
        responsibleName: "Post approval scrap test"
      }
    });
    assert.equal(postApprovalEntry.statusCode, 201, postApprovalEntry.body);
    const postApprovalEntryId = postApprovalEntry.json().data.id as string;
    const approvePostApprovalEntry = await app.inject({
      method: "POST", url: "/api/production/" + postApprovalEntryId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(approvePostApprovalEntry.statusCode, 200, approvePostApprovalEntry.body);
    const postApprovalSource = await apiPool.query(
      "SELECT warehouse_id,location_id FROM production_entries WHERE id=$1", [postApprovalEntryId]
    );
    const sourceWarehouseId = postApprovalSource.rows[0].warehouse_id as string;
    const sourceLocationId = postApprovalSource.rows[0].location_id as string;
    const sourceBeforeScrap = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [postApprovalStage.output_product_id, sourceWarehouseId, sourceLocationId]
    );
    const scrapLocation = await apiPool.query(
      `SELECT w.id AS warehouse_id,l.id AS location_id
         FROM warehouses w JOIN warehouse_locations l ON l.warehouse_id=w.id AND l.is_active=TRUE
        WHERE w.warehouse_type='SCRAP' AND w.is_active=TRUE ORDER BY w.created_at,w.id,l.code LIMIT 1`
    );
    const scrapBalanceBefore = await apiPool.query(
      "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [postApprovalStage.output_product_id, scrapLocation.rows[0].warehouse_id, scrapLocation.rows[0].location_id]
    );
    const approvedScrapKey = randomUUID();
    const approvedScrapPayload = {
      idempotencyKey: approvedScrapKey, productionEntryId: postApprovalEntryId,
      scrapType: "MANUFACTURING_DEFECT", quantity: 1, notes: "Approved stock transfer test"
    };
    const approvedScrap = await app.inject({
      method: "POST", url: "/api/production/scrap", headers: { cookie: submitter.cookie },
      payload: approvedScrapPayload
    });
    assert.equal(approvedScrap.statusCode, 201, approvedScrap.body);
    const approvedScrapMovement = await apiPool.query(
      "SELECT movement_type,quantity,total_cost,reference_type,reference_id FROM stock_movements WHERE id=$1",
      [approvedScrap.json().data.stock_movement_id]
    );
    assert.equal(approvedScrapMovement.rows[0].movement_type, "TRANSFER_IN");
    assert.equal(Number(approvedScrapMovement.rows[0].total_cost), 0);
    const linkedSourceMovement = await apiPool.query(
      "SELECT movement_type,quantity,total_cost,reference_type,reference_id FROM stock_movements WHERE reference_type='TRANSFER' AND reference_id=$1",
      [approvedScrap.json().data.stock_movement_id]
    );
    assert.equal(linkedSourceMovement.rowCount, 1);
    assert.equal(linkedSourceMovement.rows[0].movement_type, "TRANSFER_OUT");
    assert.equal(Number(linkedSourceMovement.rows[0].quantity), 1);
    const sourceAfterScrap = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [postApprovalStage.output_product_id, sourceWarehouseId, sourceLocationId]
    );
    const scrapBalanceAfter = await apiPool.query(
      "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [postApprovalStage.output_product_id, scrapLocation.rows[0].warehouse_id, scrapLocation.rows[0].location_id]
    );
    assert.equal(Number(sourceAfterScrap.rows[0].quantity), Number(sourceBeforeScrap.rows[0].quantity) - 1);
    assert.equal(Number(scrapBalanceAfter.rows[0]?.quantity ?? 0), Number(scrapBalanceBefore.rows[0]?.quantity ?? 0) + 1,
      "approved scrap must move quantity between warehouses, not create additional total stock");
    const adjustedScrapStage = await apiPool.query(
      "SELECT completed_quantity,status FROM order_stages WHERE id=$1", [postApprovalStage.id]
    );
    assert.equal(Number(adjustedScrapStage.rows[0].completed_quantity), 2,
      "scrap discovered after approval must reduce good-output progress");
    const approvedScrapReplay = await app.inject({
      method: "POST", url: "/api/production/scrap", headers: { cookie: submitter.cookie },
      payload: approvedScrapPayload
    });
    assert.equal(approvedScrapReplay.statusCode, 200, approvedScrapReplay.body);
    assert.equal(approvedScrapReplay.json().data.stock_movement_id, approvedScrap.json().data.stock_movement_id);
    assert.equal(approvedScrapReplay.json().data.source_stock_movement_id, approvedScrap.json().data.source_stock_movement_id);
    const reverseScrappedProduction = await app.inject({
      method: "POST", url: "/api/production/" + postApprovalEntryId + "/reverse",
      headers: { cookie: submitter.cookie },
      payload: { password: "Test-only-password-2026!", reason: "Must not reverse scrap-linked stock" }
    });
    assert.equal(reverseScrappedProduction.statusCode, 409, reverseScrappedProduction.body);
    assert.equal(reverseScrappedProduction.json().error.code, "PRODUCTION_HAS_SCRAP",
      "reversal must not silently restore the gross quantity after scrap has been transferred");

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
    const withdrawalListPage = await app.inject({
      method: "GET", url: "/api/shift-withdrawals?limit=1&offset=0", headers: { cookie: submitter.cookie }
    });
    assert.equal(withdrawalListPage.statusCode, 200, withdrawalListPage.body);
    assert.ok(withdrawalListPage.json().data.length <= 1);
    assert.ok(Number(withdrawalListPage.json().pagination.total) >= 1);
    assert.equal(withdrawalListPage.json().pagination.hasMore, Number(withdrawalListPage.json().pagination.total) > withdrawalListPage.json().data.length);
    const invalidWithdrawalPage = await app.inject({
      method: "GET", url: "/api/shift-withdrawals?limit=301&offset=0", headers: { cookie: submitter.cookie }
    });
    assert.equal(invalidWithdrawalPage.statusCode, 422, invalidWithdrawalPage.body);
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

    // Production percentage is accrued over the configured period and is only
    // collected when approved production earnings are actually paid to the employee.
    const percentageAdvance = await apiPool.query(
      `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,production_percentage,production_period_days,repayment_status)
       VALUES($1,100,'Production percentage integration test','PAID',$2,$3,'2099-01-01T12:00:00Z','PRODUCTION_PERCENTAGE',20,15,'OPEN')
       RETURNING id,code`,
      [submitterEmployee,submitter.userId,approver.userId]
    );
    await apiPool.query(
      "INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',100,$2,$3)",
      [submitterEmployee,approver.userId,"صرف سلفة "+percentageAdvance.rows[0].code]
    );
    const approveFinal = await app.inject({
      method: "POST", url: "/api/production/" + finalId + "/approve", headers: { cookie: approver.cookie }
    });
    assert.equal(approveFinal.statusCode, 200, approveFinal.body);
    assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[percentageAdvance.rows[0].id])).rows[0].count,0,
      "production approval must not settle an advance before worker payout");

    const settlementResponse=await app.inject({
      method:"POST",url:"/api/production/earnings/settlements",headers:{cookie:approver.cookie},
      payload:{employeeId:submitterEmployee,grossAmount:305,settlementDate:"2099-01-16",notes:"integration production settlement"}
    });
    assert.equal(settlementResponse.statusCode,201,settlementResponse.body);
    const settlement=settlementResponse.json().data;
    assert.equal(Number(settlement.cashPaid),205);
    assert.equal(Number(settlement.advanceRepaymentAmount),100,"20% of 500 approved production earnings over the 15-day period is recovered at payout");
    const productionRepayment = await apiPool.query(
      "SELECT amount,repayment_type,source_production_entry_id,settlement_id FROM advance_repayments WHERE advance_id=$1",
      [percentageAdvance.rows[0].id]
    );
    assert.equal(productionRepayment.rowCount,1);
    assert.equal(Number(productionRepayment.rows[0].amount),100);
    assert.equal(productionRepayment.rows[0].repayment_type,"PRODUCTION_PERCENTAGE");
    assert.equal(productionRepayment.rows[0].source_production_entry_id,null);
    assert.equal(productionRepayment.rows[0].settlement_id,settlement.settlement.id);
    const remainingAdvance = await apiPool.query(
      "SELECT repayment_status,amount-(SELECT COALESCE(SUM(ar.amount),0) FROM advance_repayments ar WHERE ar.advance_id=advance_requests.id) AS remaining FROM advance_requests WHERE id=$1",
      [percentageAdvance.rows[0].id]
    );
    assert.equal(remainingAdvance.rows[0].repayment_status,"SETTLED");
    assert.equal(Number(remainingAdvance.rows[0].remaining),0);
    const custodySummary=await apiPool.query(
      "SELECT direction,SUM(amount) AS amount FROM cash_custody_transactions WHERE source_id=$1 AND source_type IN ('PRODUCTION_EARNINGS_SETTLEMENT','ADVANCE_REPAYMENT_OFFSET') GROUP BY direction",
      [settlement.settlement.id]
    );
    assert.equal(Number(custodySummary.rows.find((x:any)=>x.direction==="OUT")?.amount),305);
    assert.equal(Number(custodySummary.rows.find((x:any)=>x.direction==="IN")?.amount),100);
    const repaymentLedger = await apiPool.query(
      "SELECT credit_amount,debit_amount,notes FROM employee_earnings_ledger WHERE entry_type='ADJUSTMENT' AND notes LIKE $1",
      [`%سداد سلفة ${percentageAdvance.rows[0].code}%`]
    );
    assert.equal(repaymentLedger.rowCount,1,"the repayment must update the employee balance without creating a second production expense");
    assert.equal(Number(repaymentLedger.rows[0].credit_amount),100);
    assert.equal(Number(repaymentLedger.rows[0].debit_amount),0);

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
    assert.equal(Number(reportedEmployee.debited), 410, "employee earnings report includes the advance payout, production deduction, and gross settlement; loan recovery is separately credited");
    assert.equal(Number(reportedEmployee.balance), 200, "unpaid approved earnings remain as the employee's positive balance after settling the advance");

    const stageState = await apiPool.query(
      "SELECT os.completed_quantity,os.status,po.status AS order_status FROM order_stages os JOIN production_orders po ON po.id=os.order_id WHERE os.id=$1",
      [finalStage.id]
    );
    assert.equal(Number(stageState.rows[0].completed_quantity), 10);
    assert.equal(stageState.rows[0].status, "COMPLETED");
    assert.equal(stageState.rows[0].order_status, "COMPLETED");
    const scrapOnCompletedOrder = await app.inject({
      method: "POST", url: "/api/production/scrap", headers: { cookie: submitter.cookie },
      payload: { idempotencyKey: randomUUID(), productionEntryId: finalId, scrapType: "MANUFACTURING_DEFECT", quantity: 1, notes: "Must reject completed order" }
    });
    assert.equal(scrapOnCompletedOrder.statusCode, 409, scrapOnCompletedOrder.body);
    assert.equal(scrapOnCompletedOrder.json().error.code, "ORDER_NOT_ACTIVE");
    const completedOrderScrapCount = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM production_scrap_records WHERE production_entry_id=$1",
      [finalId]
    );
    assert.equal(completedOrderScrapCount.rows[0].count, 0, "failed scrap must not create a record or stock movement");

    const addOutputToCompletedOrder = await app.inject({
      method: "POST", url: "/api/stages/" + finalStage.id + "/outputs", headers: { cookie: submitter.cookie },
      payload: { productId: finalStage.output_product_id, isDefault: true }
    });
    assert.equal(addOutputToCompletedOrder.statusCode, 409, addOutputToCompletedOrder.body);
    assert.equal(addOutputToCompletedOrder.json().error.code, "ORDER_COMPLETED_LOCKED");
    // A completed stage cannot receive machine production even if the parent order is reopened.
    await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1", [orderId]);
    const testMachine = (await apiPool.query(
      "INSERT INTO machines(name,machine_type) VALUES($1,$2) RETURNING id",
      ["Completed stage guard " + randomBytes(4).toString("hex"), "TEST"]
    )).rows[0];
    const machineProductionOnCompletedStage = await app.inject({
      method: "POST", url: "/api/machine-production", headers: { cookie: submitter.cookie },
      payload: {
        orderStageId: finalStage.id, machineId: testMachine.id, productId: finalStage.output_product_id,
        workDate: "2099-01-05", quantity: 1
      }
    });
    assert.equal(machineProductionOnCompletedStage.statusCode, 409, machineProductionOnCompletedStage.body);
    assert.equal(machineProductionOnCompletedStage.json().error.code, "ORDER_STAGE_COMPLETED");
    await apiPool.query("UPDATE production_orders SET status='COMPLETED' WHERE id=$1", [orderId]);
    const reopenCompletedOrder = await app.inject({
      method: "PATCH", url: "/api/orders/" + orderId, headers: { cookie: submitter.cookie },
      payload: { status: "IN_PROGRESS" }
    });
    assert.equal(reopenCompletedOrder.statusCode, 200, reopenCompletedOrder.body);
    const reopenedStage = await apiPool.query("SELECT status FROM order_stages WHERE id=$1", [finalStage.id]);
    assert.equal(reopenedStage.rows[0].status, "IN_PROGRESS", "reopening an order must reactivate its completed stages");

    const incompleteStageResponse = await app.inject({
      method: "POST", url: "/api/orders/" + orderId + "/stages", headers: { cookie: submitter.cookie },
      payload: { stageName: "Incomplete stage guard", sequenceNo: 3, outputProductId: finalStage.output_product_id, plannedQuantity: 999 }
    });
    assert.equal(incompleteStageResponse.statusCode, 201, incompleteStageResponse.body);
    const incompleteStageId = incompleteStageResponse.json().data.id as string;
    const forceCompleteIncompleteStage = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + incompleteStageId, headers: { cookie: submitter.cookie },
      payload: { status: "COMPLETED" }
    });
    assert.equal(forceCompleteIncompleteStage.statusCode, 409, forceCompleteIncompleteStage.body);
    assert.equal(forceCompleteIncompleteStage.json().error.code, "ORDER_STAGE_QUANTITY_INCOMPLETE");
    const cancelIncompleteStage = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + incompleteStageId, headers: { cookie: submitter.cookie },
      payload: { status: "CANCELLED" }
    });
    assert.equal(cancelIncompleteStage.statusCode, 200, cancelIncompleteStage.body);
    // Remove the isolated regression fixture so the existing dashboard assertions
    // continue to describe the original two-stage order.
    await apiPool.query("DELETE FROM order_stages WHERE id=$1", [incompleteStageId]);

    const rejectIncompleteOrder = await app.inject({
      method: "PATCH", url: "/api/orders/" + orderId, headers: { cookie: submitter.cookie },
      payload: { status: "COMPLETED" }
    });
    assert.equal(rejectIncompleteOrder.statusCode, 409, rejectIncompleteOrder.body);
    assert.equal(rejectIncompleteOrder.json().error.code, "ORDER_STAGES_INCOMPLETE");
    const reopenedStages = await apiPool.query(
      "SELECT id FROM order_stages WHERE order_id=$1 AND status='IN_PROGRESS'",
      [orderId]
    );
    for (const reopened of reopenedStages.rows) {
      const completeReopenedStage = await app.inject({
        method: "PATCH", url: "/api/order-stages/" + reopened.id, headers: { cookie: submitter.cookie },
        payload: { status: "COMPLETED" }
      });
      assert.equal(completeReopenedStage.statusCode, 200, completeReopenedStage.body);
    }
    const completeOrderAgain = await app.inject({
      method: "PATCH", url: "/api/orders/" + orderId, headers: { cookie: submitter.cookie },
      payload: { status: "COMPLETED" }
    });
    assert.equal(completeOrderAgain.statusCode, 200, completeOrderAgain.body);
    const completedStageAgain = await apiPool.query("SELECT status FROM order_stages WHERE id=$1", [finalStage.id]);
    assert.equal(completedStageAgain.rows[0].status, "COMPLETED");

    const addStageToCompletedOrder = await app.inject({
      method: "POST", url: "/api/orders/" + orderId + "/stages", headers: { cookie: submitter.cookie },
      payload: { stageName: "Must not add to completed order", sequenceNo: 3 }
    });
    assert.equal(addStageToCompletedOrder.statusCode, 409, addStageToCompletedOrder.body);
    assert.equal(addStageToCompletedOrder.json().error.code, "ORDER_COMPLETED_LOCKED");
    const editCompletedStage = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + finalStage.id, headers: { cookie: submitter.cookie },
      payload: { notes: "Must not edit completed order stage" }
    });
    assert.equal(editCompletedStage.statusCode, 409, editCompletedStage.body);
    assert.equal(editCompletedStage.json().error.code, "ORDER_COMPLETED_LOCKED");

    const dashboard = await app.inject({
      method: "GET", url: "/api/orders/" + orderId + "/dashboard", headers: { cookie: submitter.cookie }
    });
    assert.equal(dashboard.statusCode, 200, dashboard.body);
    assert.equal(dashboard.json().data.stages.length, 2);
    assert.equal(dashboard.json().data.production.length, 3, "dashboard includes the replacement good unit needed after scrap");
    assert.equal(dashboard.json().data.movements.length, 1, "order withdrawals must show only actual OUT movements, not production receipts");
    assert.equal(Number(dashboard.json().data.totals.production_cost), 525);
    assert.equal(dashboard.json().data.totals.stock_in_cost, undefined, "production receipt value must not be presented as an order withdrawal cost");
    assert.equal(Number(dashboard.json().data.totals.stock_out_cost), 100);

    const profitability = await app.inject({
      method: "GET", url: "/api/accounting/orders/" + orderId + "/profitability", headers: { cookie: submitter.cookie }
    });
    assert.equal(profitability.statusCode, 200, profitability.body);
    assert.equal(Number(profitability.json().data.laborCost), 525);
    assert.equal(Number(profitability.json().data.materialCost), 100);

    // Resolve the exact final-product order line so delivery and stock-out remain line-specific.
    const finalOrderLine = await apiPool.query("SELECT id FROM production_order_lines WHERE order_id=$1 AND product_id=$2 ORDER BY id LIMIT 1",[orderId,finalStage.output_product_id]);
    assert.equal(finalOrderLine.rowCount,1);
    // Availability is a read-only diagnostic: it must explain production and location stock separately.
    const availabilityUrl = "/api/delivery-permissions/availability?orderId=" + orderId + "&orderItemId=" + finalOrderLine.rows[0].id
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
        lines: [{ orderItemId: finalOrderLine.rows[0].id, productId: finalStage.output_product_id, warehouseId: expectedFinished.id,
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
      "SELECT movement_type,quantity,reference_type,reference_id,order_id,order_item_id FROM stock_movements WHERE reference_type='DELIVERY' AND reference_id=$1",
      [deliveryId]
    );
    assert.equal(deliveryMovement.rowCount, 1);
    assert.equal(deliveryMovement.rows[0].movement_type, "OUT");
    assert.equal(Number(deliveryMovement.rows[0].quantity), 4);
    assert.equal(deliveryMovement.rows[0].order_id, orderId);
    assert.equal(deliveryMovement.rows[0].order_item_id, finalOrderLine.rows[0].id, "delivery stock-out must retain the exact final-product line");

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

    // Continuous-scan regression: legacy cartons are resolved by the delivery API,
    // drafts survive reload, duplicate scans and wrong locations are rejected,
    // removal releases the draft line, and final release changes stock exactly once.
    const scanDraftResponse = await app.inject({
      method: "POST", url: "/api/delivery-permissions/drafts", headers: { cookie: approver.cookie },
      payload: { orderId, destination: "Continuous scan integration draft" }
    });
    assert.equal(scanDraftResponse.statusCode, 201, scanDraftResponse.body);
    const scanDraftId = scanDraftResponse.json().data.id as string;

    const wrongScanLocation = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + scanDraftId + "/scan",
      headers: { cookie: approver.cookie },
      payload: {
        cartonCode: carton.barcode,
        warehouseId: "00000000-0000-4000-8000-000000000001",
        locationId: finalSaved.rows[0].location_id
      }
    });
    assert.equal(wrongScanLocation.statusCode, 409, wrongScanLocation.body);
    assert.equal(wrongScanLocation.json().error.code, "CARTON_LOCATION_MISMATCH");

    const legacyCartonScan = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + scanDraftId + "/scan",
      headers: { cookie: approver.cookie }, payload: { cartonCode: carton.barcode }
    });
    assert.equal(legacyCartonScan.statusCode, 201, legacyCartonScan.body);
    assert.equal(legacyCartonScan.json().data.product_id, finalStage.output_product_id);
    assert.equal(Number(legacyCartonScan.json().data.quantity), 1);
    assert.equal(legacyCartonScan.json().data.product_name, (await apiPool.query(
      "SELECT name FROM products WHERE id=$1", [finalStage.output_product_id]
    )).rows[0].name);

    const duplicateLegacyScan = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + scanDraftId + "/scan",
      headers: { cookie: approver.cookie }, payload: { cartonCode: carton.code }
    });
    assert.equal(duplicateLegacyScan.statusCode, 409, duplicateLegacyScan.body);
    assert.equal(duplicateLegacyScan.json().error.code, "DUPLICATE_CARTON_CODE");

    const restoredDraft = await app.inject({
      method: "GET", url: "/api/delivery-permissions/drafts/active?orderId=" + orderId,
      headers: { cookie: approver.cookie }
    });
    assert.equal(restoredDraft.statusCode, 200, restoredDraft.body);
    assert.equal(restoredDraft.json().data.id, scanDraftId);
    assert.equal(restoredDraft.json().data.lines.length, 1);

    const removedDraftLineId = legacyCartonScan.json().data.id as string;
    const removeDraftLine = await app.inject({
      method: "DELETE", url: "/api/delivery-permissions/" + scanDraftId + "/scan/" + removedDraftLineId,
      headers: { cookie: approver.cookie }
    });
    assert.equal(removeDraftLine.statusCode, 200, removeDraftLine.body);
    const emptyRestoredDraft = await app.inject({
      method: "GET", url: "/api/delivery-permissions/drafts/active?orderId=" + orderId,
      headers: { cookie: approver.cookie }
    });
    assert.equal(emptyRestoredDraft.statusCode, 200, emptyRestoredDraft.body);
    assert.equal(emptyRestoredDraft.json().data.lines.length, 0);

    const rescannedLegacyCarton = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + scanDraftId + "/scan",
      headers: { cookie: approver.cookie }, payload: { cartonCode: carton.barcode }
    });
    assert.equal(rescannedLegacyCarton.statusCode, 201, rescannedLegacyCarton.body);
    const readyScannedDraft = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + scanDraftId + "/ready",
      headers: { cookie: approver.cookie }
    });
    assert.equal(readyScannedDraft.statusCode, 200, readyScannedDraft.body);
    assert.equal(readyScannedDraft.json().data.status, "READY");

    const scannedDraftRelease = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + scanDraftId + "/release",
      headers: { cookie: approver.cookie }, payload: { scanCode: readyScannedDraft.json().data.code }
    });
    assert.equal(scannedDraftRelease.statusCode, 200, scannedDraftRelease.body);
    assert.equal(scannedDraftRelease.json().data.status, "RELEASED");
    const afterScannedDraftRelease = await apiPool.query(
      "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(Number(afterScannedDraftRelease.rows[0].quantity), 3,
      "continuous-scan release must subtract the scanned carton quantity exactly once");
    const emptyLegacyCarton = await apiPool.query("SELECT quantity,status FROM cartons WHERE id=$1", [carton.id]);
    assert.equal(Number(emptyLegacyCarton.rows[0].quantity), 0);
    assert.equal(emptyLegacyCarton.rows[0].status, "EMPTY");

    // Continuous-scan must also resolve coding units (not only legacy cartons),
    // and release must update both the coding-unit ledger and inventory exactly once.
    const codingPackagingType = await apiPool.query(
      "SELECT id FROM coding_packaging_types WHERE is_active=TRUE ORDER BY id LIMIT 1"
    );
    assert.ok(codingPackagingType.rowCount, "migrations must seed an active coding packaging type");
    const codingProduction = await apiPool.query(
      "SELECT id FROM production_entries WHERE order_stage_id=$1 AND product_id=$2 AND status='APPROVED' ORDER BY created_at DESC LIMIT 1",
      [finalStage.id, finalStage.output_product_id]
    );
    assert.ok(codingProduction.rowCount, "approved final-stage production must be available for coding");
    const codingUnitResponse = await app.inject({
      method: "POST", url: "/api/coding/units", headers: { cookie: approver.cookie },
      payload: {
        packagingTypeId: codingPackagingType.rows[0].id,
        productId: finalStage.output_product_id,
        productionEntryId: codingProduction.rows[0].id,
        quantity: 1,
        weight: 0.4
      }
    });
    assert.equal(codingUnitResponse.statusCode, 201, codingUnitResponse.body);
    const codingUnit = codingUnitResponse.json().data;
    assert.equal(Number(codingUnit.quantity), 1);
    assert.ok(codingUnit.barcode);

    const codingDraftResponse = await app.inject({
      method: "POST", url: "/api/delivery-permissions/drafts", headers: { cookie: approver.cookie },
      payload: { orderId, destination: "Continuous scan coding-unit integration" }
    });
    assert.equal(codingDraftResponse.statusCode, 201, codingDraftResponse.body);
    const codingDraftId = codingDraftResponse.json().data.id as string;
    const codingScan = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + codingDraftId + "/scan",
      headers: { cookie: approver.cookie }, payload: { cartonCode: codingUnit.barcode }
    });
    assert.equal(codingScan.statusCode, 201, codingScan.body);
    const readyCodingDraft = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + codingDraftId + "/ready",
      headers: { cookie: approver.cookie }
    });
    assert.equal(readyCodingDraft.statusCode, 200, readyCodingDraft.body);
    const codingRelease = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + codingDraftId + "/release",
      headers: { cookie: approver.cookie }, payload: { scanCode: readyCodingDraft.json().data.code }
    });
    assert.equal(codingRelease.statusCode, 200, codingRelease.body);
    assert.equal(codingRelease.json().data.status, "RELEASED");
    const codingUnitAfterRelease = await apiPool.query(
      "SELECT quantity,status FROM coding_units WHERE id=$1", [codingUnit.id]
    );
    assert.equal(Number(codingUnitAfterRelease.rows[0].quantity), 0);
    assert.equal(codingUnitAfterRelease.rows[0].status, "OUT");
    const codingMovementCount = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM coding_unit_movements WHERE coding_unit_id=$1 AND movement_type='OUT'",
      [codingUnit.id]
    );
    assert.equal(codingMovementCount.rows[0].count, 1);
    const stockAfterCodingRelease = await apiPool.query(
      "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(Number(stockAfterCodingRelease.rows[0].quantity), 2);
    const duplicateCodingRelease = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + codingDraftId + "/release",
      headers: { cookie: approver.cookie }, payload: { scanCode: readyCodingDraft.json().data.code }
    });
    assert.equal(duplicateCodingRelease.statusCode, 409, duplicateCodingRelease.body);
    assert.equal(duplicateCodingRelease.json().error.code, "INVALID_STATUS");
    assert.equal((await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM stock_movements WHERE reference_type='DELIVERY' AND reference_id=$1",
      [codingDraftId]
    )).rows[0].count, 1, "releasing a coding-unit delivery twice must not duplicate stock movements");

    // Finalization must re-check approved production, not just carton quantity.
    // Temporarily provide enough stock to create an oversized test carton, then restore
    // the isolated test balance so the assertion exercises the production guard first.
    await apiPool.query(
      "UPDATE stock_balances SET quantity=4 WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    const overProductionCartonResponse = await app.inject({
      method: "POST", url: "/api/warehouse/cartons", headers: { cookie: approver.cookie },
      payload: {
        productId: finalStage.output_product_id, warehouseId: expectedFinished.id,
        locationId: finalSaved.rows[0].location_id, quantity: 4, weight: 1,
        batchCode: "CONTINUOUS-OVER-PRODUCTION", status: "SEALED"
      }
    });
    await apiPool.query(
      "UPDATE stock_balances SET quantity=3 WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(overProductionCartonResponse.statusCode, 201, overProductionCartonResponse.body);
    const overProductionDraftResponse = await app.inject({
      method: "POST", url: "/api/delivery-permissions/drafts", headers: { cookie: approver.cookie },
      payload: { orderId, destination: "Reject over-production scan draft" }
    });
    assert.equal(overProductionDraftResponse.statusCode, 201, overProductionDraftResponse.body);
    const overProductionDraftId = overProductionDraftResponse.json().data.id as string;
    const overProductionScan = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + overProductionDraftId + "/scan",
      headers: { cookie: approver.cookie },
      payload: { cartonCode: overProductionCartonResponse.json().data.barcode }
    });
    assert.equal(overProductionScan.statusCode, 201, overProductionScan.body);
    const stockBeforeProductionRejection = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    const stockBeforeGuardTestValueForProductionCheck = Number(stockBeforeProductionRejection.rows[0].inventory_value);
    const rejectOverProduction = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + overProductionDraftId + "/ready",
      headers: { cookie: approver.cookie }
    });
    assert.equal(rejectOverProduction.statusCode, 409, rejectOverProduction.body);
    assert.equal(rejectOverProduction.json().error.code, "DELIVERY_EXCEEDS_PRODUCTION");
    const stockAfterProductionRejection = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(Number(stockAfterProductionRejection.rows[0].quantity), 3,
      "rejected over-production draft must not change stock quantity");
    assert.equal(Number(stockAfterProductionRejection.rows[0].inventory_value),
      Number(stockBeforeGuardTestValueForProductionCheck),
      "rejected over-production draft must not change stock inventory value");
    const cancelOverProductionDraft = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + overProductionDraftId + "/cancel-draft",
      headers: { cookie: approver.cookie }
    });
    assert.equal(cancelOverProductionDraft.statusCode, 200, cancelOverProductionDraft.body);

    // Independently verify the stock guard while production availability is still sufficient.
    const lowStockCartonResponse = await app.inject({
      method: "POST", url: "/api/warehouse/cartons", headers: { cookie: approver.cookie },
      payload: {
        productId: finalStage.output_product_id, warehouseId: expectedFinished.id,
        locationId: finalSaved.rows[0].location_id, quantity: 2, weight: 0.8,
        batchCode: "CONTINUOUS-LOW-STOCK", status: "SEALED"
      }
    });
    assert.equal(lowStockCartonResponse.statusCode, 201, lowStockCartonResponse.body);
    const lowStockDraftResponse = await app.inject({
      method: "POST", url: "/api/delivery-permissions/drafts", headers: { cookie: approver.cookie },
      payload: { orderId, destination: "Reject low-stock scan draft" }
    });
    assert.equal(lowStockDraftResponse.statusCode, 201, lowStockDraftResponse.body);
    const lowStockDraftId = lowStockDraftResponse.json().data.id as string;
    const lowStockScan = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + lowStockDraftId + "/scan",
      headers: { cookie: approver.cookie },
      payload: { cartonCode: lowStockCartonResponse.json().data.barcode }
    });
    assert.equal(lowStockScan.statusCode, 201, lowStockScan.body);
    const stockBeforeGuardTest = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
      [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
    );
    assert.equal(Number(stockBeforeGuardTest.rows[0].quantity), 3);
    try {
      await apiPool.query(
        "UPDATE stock_balances SET quantity=1 WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
        [finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
      );
      const rejectLowStock = await app.inject({
        method: "POST", url: "/api/delivery-permissions/" + lowStockDraftId + "/ready",
        headers: { cookie: approver.cookie }
      });
      assert.equal(rejectLowStock.statusCode, 409, rejectLowStock.body);
      assert.equal(rejectLowStock.json().error.code, "DELIVERY_EXCEEDS_STOCK");
    } finally {
      await apiPool.query(
        "UPDATE stock_balances SET quantity=$1,inventory_value=$2 WHERE product_id=$3 AND warehouse_id=$4 AND location_id=$5",
        [stockBeforeGuardTest.rows[0].quantity, stockBeforeGuardTest.rows[0].inventory_value,
          finalStage.output_product_id, expectedFinished.id, finalSaved.rows[0].location_id]
      );
    }
    const cancelLowStockDraft = await app.inject({
      method: "POST", url: "/api/delivery-permissions/" + lowStockDraftId + "/cancel-draft",
      headers: { cookie: approver.cookie }
    });
    assert.equal(cancelLowStockDraft.statusCode, 200, cancelLowStockDraft.body);

    // Reopen a completed order before posting additional manual finance entries.
    const reopenForFinalCost=await app.inject({
      method:"PATCH",url:"/api/orders/"+orderId,headers:{cookie:approver.cookie},payload:{status:"IN_PROGRESS"}
    });
    assert.equal(reopenForFinalCost.statusCode,200,reopenForFinalCost.body);

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
    assert.equal(Number(finalProfitability.json().data.laborCost), 525);
    assert.equal(Number(finalProfitability.json().data.totalCost), 675);
    assert.equal(Number(finalProfitability.json().data.profit), 325);
    assert.equal(Number(finalProfitability.json().data.marginPercent), 32.5);

    const accountingSummary = await app.inject({
      method: "GET", url: "/api/accounting/summary", headers: { cookie: submitter.cookie }
    });
    assert.equal(accountingSummary.statusCode, 200, accountingSummary.body);
    // The contract-guard regression adds $80 and its concurrent idempotency case adds
    // exactly one $6 entry; retries must not increase the total a second time.
    assert.equal(Number(accountingSummary.json().data.total_in), 1086);
    assert.equal(Number(accountingSummary.json().data.total_out), 50);
    assert.equal(Number(accountingSummary.json().data.net), 1036);

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
    await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1", [concurrentOrderId]);
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

    const orderValueTest = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: { orderName: "Shift leader value visibility test", contractValue: 12345, orderDate: "2099-01-08", stages: [{ stageName: "Value visibility stage", sequenceNo: 1, outputProductName: "Value visibility product", plannedQuantity: 1, stageRate: 1, stageRateMethod: "PER_PIECE" }] }
    });
    assert.equal(orderValueTest.statusCode, 201, orderValueTest.body);
    const orderValueTestId = orderValueTest.json().data.id as string;
    const leader = await makeUser("shift-leader-value-visibility", true);
    await apiPool.query("DELETE FROM user_roles WHERE user_id=$1", [leader.userId]);
    await apiPool.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='shift_leader' ON CONFLICT DO NOTHING",
      [leader.userId]
    );
    const leaderOrders = await app.inject({
      method: "GET", url: "/api/orders", headers: { cookie: leader.cookie }
    });
    assert.equal(leaderOrders.statusCode, 200, leaderOrders.body);
    const leaderOrderRow = leaderOrders.json().data.find((x: {id:string}) => x.id === orderValueTestId);
    assert.ok(leaderOrderRow, "shift leaders can still see operational order details");
    assert.equal(Object.hasOwn(leaderOrderRow, "contract_value"), false,
      "shift leaders must not receive order contract values");
    const leaderOrderDetail = await app.inject({
      method: "GET", url: "/api/orders/" + orderValueTestId, headers: { cookie: leader.cookie }
    });
    assert.equal(leaderOrderDetail.statusCode, 200, leaderOrderDetail.body);
    assert.equal(Object.hasOwn(leaderOrderDetail.json().data, "contract_value"), false,
      "shift leaders must not receive contract value from order detail API either");

    // A pending production row can be cancelled only after password confirmation.
    const pendingOrder = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: submitter.cookie },
      payload: { orderName: "Pending production delete test", orderDate: "2099-01-07",
        stages: [{ stageName: "Pending delete stage", sequenceNo: 1, outputProductName: "Pending delete product", plannedQuantity: 2, stageRate: 1, stageRateMethod: "PER_PIECE" }] }
    });
    assert.equal(pendingOrder.statusCode, 201, pendingOrder.body);
    const pendingOrderId = pendingOrder.json().data.id as string;
    await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1", [pendingOrderId]);
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
    await apiPool.query("UPDATE production_orders SET status='IN_PROGRESS' WHERE id=$1", [priceOrderId]);
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
