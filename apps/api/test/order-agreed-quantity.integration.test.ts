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

test("agreed quantity edit mid-run: permission, reason, recorded floor, audit", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const dbName = "tezkar_agreed_qty_" + randomBytes(6).toString("hex");
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
    process.env.SESSION_SECRET = "test-only-agreed-quantity-session-secret";
    process.env.NODE_ENV = "test";

    const [
      { default: Fastify }, { default: cookie }, { authRoutes }, { orderRoutes }, { hashPassword }, poolModule
    ] = await Promise.all([
      import("fastify"), import("@fastify/cookie"), import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/orders/orders.routes.js"), import("../src/modules/auth/auth.service.js"), import("../src/db/pool.js")
    ]);
    apiPool = poolModule.pool;
    app = Fastify();
    await app.register(cookie, { secret: process.env.SESSION_SECRET });
    app.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await app.register(authRoutes);
    await app.register(orderRoutes);

    async function makeUser(label: string, roleCode: string | null) {
      const username = label.toLowerCase() + "-" + randomBytes(5).toString("hex");
      const user = await apiPool!.query(
        "INSERT INTO users(username,password_hash,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,TRUE,FALSE,FALSE) RETURNING id",
        [username, hashPassword("Test-only-password-2026!")]
      );
      if (roleCode === "manager") {
        await apiPool!.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING", [user.rows[0].id]);
        await apiPool!.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING");
      } else if (roleCode) {
        const role = await apiPool!.query("INSERT INTO roles(code,name,is_active) VALUES($1,$2,TRUE) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id", [roleCode, roleCode]);
        await apiPool!.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [user.rows[0].id, role.rows[0].id]);
        await apiPool!.query(
          "INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code IN ('orders.manage_stages') ON CONFLICT DO NOTHING",
          [role.rows[0].id]
        );
      }
      const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "Test-only-password-2026!" } });
      assert.equal(login.statusCode, 200, login.body);
      const setCookie = login.headers["set-cookie"];
      assert.ok(setCookie);
      return { userId: user.rows[0].id as string, cookie: (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0] };
    }

    const manager = await makeUser("manager", "manager");
    const stageOnly = await makeUser("stageonly", "stage_only_test_role");

    const orderResponse = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: manager.cookie },
      payload: { orderName: "طلبية اختبار الكمية", stages: [{ stageName: "تشغيل", outputProductName: "منتج نهائي اختبار", sequenceNo: 1, plannedQuantity: 1000, isFinalProduct: true }] }
    });
    assert.equal(orderResponse.statusCode, 201, orderResponse.body);
    const orderId = orderResponse.json().data.id as string;

    const stageRow = await apiPool.query("SELECT id,order_item_id FROM order_stages WHERE order_id=$1", [orderId]);
    assert.equal(stageRow.rowCount, 1);
    const stageId = stageRow.rows[0].id as string;
    const lineId = stageRow.rows[0].order_item_id as string;
    assert.ok(lineId, "final stage must be linked to a production order line");

    // Pre-activity: quantity edits keep flowing through the derivation path.
    const preActivity = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: manager.cookie },
      payload: { plannedQuantity: 800 }
    });
    assert.equal(preActivity.statusCode, 200, preActivity.body);
    const preLine = await apiPool.query("SELECT quantity FROM production_order_lines WHERE id=$1", [lineId]);
    assert.equal(Number(preLine.rows[0].quantity), 800);

    // Fabricate activity: a DRAFT delivery permission with 500 on this line.
    const lineInfo = await apiPool.query("SELECT product_id,unit_id FROM production_order_lines WHERE id=$1", [lineId]);
    const warehouse = await apiPool.query("INSERT INTO warehouses(name) VALUES('مخزن اختبار') RETURNING id");
    const location = await apiPool.query("INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES($1,'A-1','موقع اختبار') RETURNING id", [warehouse.rows[0].id]);
    const delivery = await apiPool.query(
      "INSERT INTO delivery_permissions(destination,created_by,order_id,status) VALUES('جهة اختبار',$1,$2,'DRAFT') RETURNING id",
      [manager.userId, orderId]
    );
    await apiPool.query(
      "INSERT INTO delivery_permission_lines(delivery_permission_id,order_item_id,product_id,warehouse_id,location_id,quantity,unit_id) VALUES($1,$2,$3,$4,$5,500,$6)",
      [delivery.rows[0].id, lineId, lineInfo.rows[0].product_id, warehouse.rows[0].id, location.rows[0].id, lineInfo.rows[0].unit_id]
    );

    // Below the recorded floor -> rejected.
    const belowFloor = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: manager.cookie },
      payload: { plannedQuantity: 400, reason: "العميل قلل الكمية" }
    });
    assert.equal(belowFloor.statusCode, 409, belowFloor.body);
    assert.equal(belowFloor.json().error.code, "AGREED_QUANTITY_BELOW_RECORDED");

    // Reason is mandatory once the order has activity.
    const noReason = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: manager.cookie },
      payload: { plannedQuantity: 600 }
    });
    assert.equal(noReason.statusCode, 422, noReason.body);
    assert.equal(noReason.json().error.code, "AGREED_QUANTITY_REASON_REQUIRED");

    // A stage manager without the dedicated permission cannot edit mid-run.
    const noPermission = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: stageOnly.cookie },
      payload: { plannedQuantity: 600, reason: "محاولة بدون صلاحية" }
    });
    assert.equal(noPermission.statusCode, 403, noPermission.body);
    assert.equal(noPermission.json().error.code, "AGREED_QUANTITY_PERMISSION_REQUIRED");

    // Zero is not a valid agreed quantity.
    const zero = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: manager.cookie },
      payload: { plannedQuantity: 0, reason: "تجربة صفر" }
    });
    assert.equal(zero.statusCode, 422, zero.body);
    assert.equal(zero.json().error.code, "AGREED_QUANTITY_INVALID");

    // Happy path: line and stage update together and an audit row is written.
    const ok = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: manager.cookie },
      payload: { plannedQuantity: 600, reason: "اتفاق جديد مع العميل" }
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(Number(ok.json().data.planned_quantity), 600);
    const afterLine = await apiPool.query("SELECT quantity FROM production_order_lines WHERE id=$1", [lineId]);
    assert.equal(Number(afterLine.rows[0].quantity), 600);
    const audit = await apiPool.query(
      "SELECT before_data,after_data,metadata FROM audit_log WHERE module='orders' AND entity_type='production_order_line' AND entity_id=$1 AND action='update_agreed_quantity'",
      [lineId]
    );
    assert.equal(audit.rowCount, 1, "an audit row must record the agreed-quantity change");
    assert.equal(Number(audit.rows[0].before_data.quantity), 800);
    assert.equal(Number(audit.rows[0].after_data.quantity), 600);
    assert.equal(audit.rows[0].metadata.reason, "اتفاق جديد مع العميل");

    // Structural changes stay locked once the order has activity.
    const structural = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: manager.cookie },
      payload: { outputProductName: "منتج مختلف تماما" }
    });
    assert.equal(structural.statusCode, 409, structural.body);
    assert.equal(structural.json().error.code, "ORDER_FINAL_PRODUCTS_LOCKED");

    // Renaming the stage while sending the same product (what the edit modal does) no longer trips the lock.
    const rename = await app.inject({
      method: "PATCH", url: "/api/order-stages/" + stageId, headers: { cookie: manager.cookie },
      payload: { stageName: "تشغيل معدل", outputProductName: "منتج نهائي اختبار" }
    });
    assert.equal(rename.statusCode, 200, rename.body);
    const renamed = await apiPool.query("SELECT s.name FROM order_stages os JOIN stages s ON s.id=os.stage_id WHERE os.id=$1", [stageId]);
    assert.equal(renamed.rows[0].name, "تشغيل معدل");
  } finally {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    const admin2 = new pg.Client({ connectionString: adminUrl });
    await admin2.connect();
    try {
      await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin2.end();
    }
  }
});
