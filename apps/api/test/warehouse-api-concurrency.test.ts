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
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:",
    "TEST_DATABASE_URL must use PostgreSQL");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres");
}

test("warehouse movement HTTP route serializes concurrent receipts and opposing transfers", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl, "TEST_DATABASE_URL must point to a disposable PostgreSQL test server");
  assertDisposableDatabaseUrl(adminUrl);

  const databaseName = "tezkar_warehouse_api_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + databaseName;
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
    process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
    process.env.NODE_ENV = "test";

    const [
      { default: Fastify },
      { default: cookie },
      { authRoutes },
      { warehouseRoutes },
      { hashPassword },
      poolModule
    ] = await Promise.all([
      import("fastify"),
      import("@fastify/cookie"),
      import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/warehouse/warehouse.routes.js"),
      import("../src/modules/auth/auth.service.js"),
      import("../src/db/pool.js")
    ]);
    apiPool = poolModule.pool;

    app = Fastify();
    await app.register(cookie, { secret: process.env.SESSION_SECRET });
    app.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await app.register(authRoutes);
    await app.register(warehouseRoutes);

    const employee = await apiPool.query(
      "INSERT INTO employees(full_name) VALUES ('Warehouse concurrency test') RETURNING id"
    );
    const password = "Test-Only-Password-2026!";
    const username = "warehouse-api-" + randomBytes(5).toString("hex");
    const user = await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES ($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      [username, hashPassword(password), employee.rows[0].id]
    );
    await apiPool.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
      [user.rows[0].id]
    );
    await apiPool.query(
      "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING"
    );

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password }
    });
    assert.equal(login.statusCode, 200, login.body);
    const setCookie = login.headers["set-cookie"];
    assert.ok(setCookie, "login must issue a session cookie");
    const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const unit = await apiPool.query("SELECT id FROM units WHERE code='PCS' LIMIT 1");
    assert.ok(unit.rowCount, "migrations should seed the PCS unit");
    const product = await apiPool.query(
      "INSERT INTO products(name,product_type,unit_id,track_inventory,is_active) VALUES ($1,'FINISHED_GOOD',$2,TRUE,TRUE) RETURNING id",
      ["Warehouse API concurrency " + randomBytes(4).toString("hex"), unit.rows[0].id]
    );
    const sourceWarehouse = await apiPool.query("INSERT INTO warehouses(name) VALUES ('API concurrency source') RETURNING id");
    const targetWarehouse = await apiPool.query("INSERT INTO warehouses(name) VALUES ('API concurrency target') RETURNING id");
    const sourceLocation = await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES ($1,'A','Source') RETURNING id",
      [sourceWarehouse.rows[0].id]
    );
    const targetLocation = await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES ($1,'B','Target') RETURNING id",
      [targetWarehouse.rows[0].id]
    );

    const receive = (warehouseId: string, locationId: string, quantity: number, unitCost: number) =>
      app!.inject({
        method: "POST",
        url: "/api/warehouse/movements",
        headers: { cookie: cookieHeader },
        payload: {
          movementType: "IN",
          productId: product.rows[0].id,
          warehouseId,
          locationId,
          quantity,
          unitCost
        }
      });

    const receipts = await Promise.all([
      receive(sourceWarehouse.rows[0].id, sourceLocation.rows[0].id, 5, 2),
      receive(sourceWarehouse.rows[0].id, sourceLocation.rows[0].id, 7, 3)
    ]);
    assert.deepEqual(receipts.map(response => response.statusCode), [201, 201],
      receipts.map(response => `${response.statusCode}: ${response.body}`).join("\n"));

    const sourceAfterReceipts = await apiPool.query(
      "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3",
      [product.rows[0].id, sourceWarehouse.rows[0].id, sourceLocation.rows[0].id]
    );
    assert.equal(sourceAfterReceipts.rowCount, 1, "concurrent first receipts must create one stock balance");
    assert.equal(Number(sourceAfterReceipts.rows[0].quantity), 12, "both receipt quantities must be reflected");
    assert.equal(Number(sourceAfterReceipts.rows[0].inventory_value), 31, "both receipt costs must be reflected");

    const targetReceipt = await receive(targetWarehouse.rows[0].id, targetLocation.rows[0].id, 10, 4);
    assert.equal(targetReceipt.statusCode, 201, targetReceipt.body);

    const transfer = (warehouseId: string, locationId: string, targetWarehouseId: string,
      targetLocationId: string, quantity: number) => app!.inject({
      method: "POST",
      url: "/api/warehouse/movements",
      headers: { cookie: cookieHeader },
      payload: {
        movementType: "TRANSFER_OUT",
        productId: product.rows[0].id,
        warehouseId,
        locationId,
        targetWarehouseId,
        targetLocationId,
        quantity
      }
    });

    const transfers = await Promise.all([
      transfer(sourceWarehouse.rows[0].id, sourceLocation.rows[0].id,
        targetWarehouse.rows[0].id, targetLocation.rows[0].id, 3),
      transfer(targetWarehouse.rows[0].id, targetLocation.rows[0].id,
        sourceWarehouse.rows[0].id, sourceLocation.rows[0].id, 4)
    ]);
    assert.deepEqual(transfers.map(response => response.statusCode), [201, 201],
      transfers.map(response => `${response.statusCode}: ${response.body}`).join("\n"));

    const balances = await apiPool.query(
      "SELECT warehouse_id,quantity,inventory_value FROM stock_balances WHERE product_id=$1 ORDER BY warehouse_id",
      [product.rows[0].id]
    );
    assert.equal(balances.rowCount, 2, "the product should have one balance in each warehouse");
    const source = balances.rows.find(row => row.warehouse_id === sourceWarehouse.rows[0].id);
    const destination = balances.rows.find(row => row.warehouse_id === targetWarehouse.rows[0].id);
    assert.equal(Number(source?.quantity), 13, "opposing transfers should leave 13 units at the source");
    assert.equal(Number(destination?.quantity), 9, "opposing transfers should leave 9 units at the destination");
    assert.equal(Number(source?.quantity) + Number(destination?.quantity), 22,
      "concurrent transfers must preserve total stock");

    const movementCount = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM stock_movements WHERE product_id=$1",
      [product.rows[0].id]
    );
    assert.equal(movementCount.rows[0].count, 7,
      "receipts and transfers should create complete source/destination movement records");

    const managerMovements = await app.inject({
      method: "GET",
      url: "/api/warehouse/movements",
      headers: { cookie: cookieHeader }
    });
    assert.equal(managerMovements.statusCode, 200, managerMovements.body);
    assert.ok(Array.isArray(managerMovements.json().data),
      "movement history must load without joining the removed legacy orders table");
    assert.equal(Object.hasOwn(managerMovements.json().data[0] ?? {}, "unit_cost"), true,
      "warehouse cost viewers retain movement cost details");

    const leaderEmployee = await apiPool.query(
      "INSERT INTO employees(full_name) VALUES ('Warehouse shift leader test') RETURNING id"
    );
    const leaderUsername = "warehouse-leader-" + randomBytes(5).toString("hex");
    const leaderUser = await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES ($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      [leaderUsername, hashPassword(password), leaderEmployee.rows[0].id]
    );
    await apiPool.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='shift_leader' ON CONFLICT DO NOTHING",
      [leaderUser.rows[0].id]
    );
    const leaderLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: leaderUsername, password }
    });
    assert.equal(leaderLogin.statusCode, 200, leaderLogin.body);
    const leaderSetCookie = leaderLogin.headers["set-cookie"];
    assert.ok(leaderSetCookie, "shift leader login must issue a session cookie");
    const leaderCookie = (Array.isArray(leaderSetCookie) ? leaderSetCookie[0] : leaderSetCookie).split(";")[0];

    const leaderStock = await app.inject({
      method: "GET", url: "/api/warehouse/stock", headers: { cookie: leaderCookie }
    });
    assert.equal(leaderStock.statusCode, 200, leaderStock.body);
    assert.ok(leaderStock.json().data.length > 0);
    for (const row of leaderStock.json().data) {
      assert.equal(Object.hasOwn(row, "avg_unit_cost"), false, "shift leaders must not receive average cost");
      assert.equal(Object.hasOwn(row, "inventory_value"), false, "shift leaders must not receive inventory value");
    }

    const leaderLots = await app.inject({
      method: "GET", url: "/api/warehouse/lots", headers: { cookie: leaderCookie }
    });
    assert.equal(leaderLots.statusCode, 200, leaderLots.body);
    for (const row of leaderLots.json().data) {
      assert.equal(Object.hasOwn(row, "unit_cost"), false, "shift leaders must not receive lot unit cost");
    }

    const leaderMovements = await app.inject({
      method: "GET", url: "/api/warehouse/movements", headers: { cookie: leaderCookie }
    });
    assert.equal(leaderMovements.statusCode, 200, leaderMovements.body);
    assert.ok(leaderMovements.json().data.length > 0);
    for (const row of leaderMovements.json().data) {
      assert.equal(Object.hasOwn(row, "unit_cost"), false, "shift leaders must not receive movement unit cost");
      assert.equal(Object.hasOwn(row, "total_cost"), false, "shift leaders must not receive movement total cost");
      assert.equal(Object.hasOwn(row, "order_id"), false, "shift leaders must not receive linked order IDs");
      assert.equal(Object.hasOwn(row, "order_code"), false, "shift leaders must not receive linked order codes");
      assert.equal(Object.hasOwn(row, "order_name"), false, "shift leaders must not receive linked order names");
    }

    const leaderDashboard = await app.inject({
      method: "GET", url: "/api/warehouse/dashboard", headers: { cookie: leaderCookie }
    });
    assert.equal(leaderDashboard.statusCode, 403, "shift leaders must not access the warehouse cost dashboard");
  } finally {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    try {
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
