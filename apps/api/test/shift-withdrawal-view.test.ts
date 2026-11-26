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
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()), "test DB must be local");
  assert.equal(url.pathname.slice(1), "postgres", "test DB admin connection must target postgres");
}

// Shift-leader visibility of shift withdrawals (request: 2026-11-26): migration
// 2026112602 creates warehouse.shift_withdrawal.view and grants it to shift_leader.
// Holders of the new permission (or the existing warehouse.view) can list and read
// withdrawals; other roles get 403; view alone never grants create.
test("shift withdrawals: shift_withdrawal.view grants list/detail without warehouse.view", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_withdrawal_view_" + randomBytes(6).toString("hex");
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
    process.env.SESSION_SECRET = "test-only-withdrawal-view-session-secret-long";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { shiftWithdrawalRoutes }, { hashPassword }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/warehouse/shift-withdrawals.routes.js"),
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
    await server.register(shiftWithdrawalRoutes);

    // Migration must have created the permission and granted it to shift_leader.
    const seededGrant = await apiPool.query(
      `SELECT 1 FROM role_permissions rp
         JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
        WHERE r.code='shift_leader' AND p.code='warehouse.shift_withdrawal.view'`
    );
    assert.equal(seededGrant.rowCount, 1, "migration grants warehouse.shift_withdrawal.view to shift_leader");

    const suffix = randomBytes(4).toString("hex");
    const password = "Test-WithdrawalView-2026!";
    const mkUser = async (username: string) => (await apiPool!.query(
      "INSERT INTO users(username,password_hash,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,TRUE,FALSE,FALSE) RETURNING id",
      [username, hashPassword(password)]
    )).rows[0];
    const grantPerms = async (userId: string, codes: string[]) => {
      const role = (await apiPool!.query("INSERT INTO roles(code,name) VALUES($1,$2) RETURNING id", ["r_" + randomBytes(4).toString("hex"), "test role"])).rows[0];
      await apiPool!.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [userId, role.id]);
      for (const code of codes) {
        await apiPool!.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2", [role.id, code]);
      }
    };
    const login = async (username: string) => {
      const res = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
      assert.equal(res.statusCode, 200, res.body);
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    };

    const viewer = await mkUser("viewer-" + suffix);
    await grantPerms(viewer.id, ["warehouse.shift_withdrawal.view"]);
    const warehouseUser = await mkUser("warehouse-" + suffix);
    await grantPerms(warehouseUser.id, ["warehouse.view"]);
    const outsider = await mkUser("outsider-" + suffix);
    await grantPerms(outsider.id, ["production.create"]);

    // Seed one withdrawal with one line directly (view tests do not exercise create).
    const rateGroup = (await apiPool.query("INSERT INTO rate_groups(name) VALUES('Withdrawal view rate group') RETURNING id")).rows[0];
    const shift = (await apiPool.query(
      "INSERT INTO shifts(name,start_time,end_time,rate_group_id) VALUES('Withdrawal view shift','08:00','16:00',$1) RETURNING id",
      [rateGroup.id]
    )).rows[0];
    const unit = (await apiPool.query("SELECT id FROM units WHERE code='PCS' LIMIT 1")).rows[0];
    const product = (await apiPool.query(
      "INSERT INTO products(name,product_type,unit_id) VALUES('Withdrawal view product','RAW_MATERIAL',$1) RETURNING id",
      [unit.id]
    )).rows[0];
    const warehouse = (await apiPool.query("SELECT id FROM warehouses WHERE is_active=TRUE ORDER BY created_at,id LIMIT 1")).rows[0];
    assert.ok(warehouse, "migrations must create at least one warehouse");
    const location = (await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name,is_active) VALUES($1,'WD-VIEW-LOC','Withdrawal view location',TRUE) RETURNING id",
      [warehouse.id]
    )).rows[0];
    const withdrawal = (await apiPool.query(
      "INSERT INTO shift_withdrawals(shift_id,withdrawal_date,employee_id,notes,created_by) VALUES($1,CURRENT_DATE,NULL,'سحب تجريبي',$2) RETURNING id",
      [shift.id, viewer.id]
    )).rows[0];
    await apiPool.query(
      "INSERT INTO shift_withdrawal_lines(withdrawal_id,product_id,warehouse_id,location_id,quantity,unit_id,notes) VALUES($1,$2,$3,$4,5,$5,'سطر تجريبي')",
      [withdrawal.id, product.id, warehouse.id, location.id, unit.id]
    );

    const viewerCookie = await login("viewer-" + suffix);
    const warehouseCookie = await login("warehouse-" + suffix);
    const outsiderCookie = await login("outsider-" + suffix);

    // 1) warehouse.shift_withdrawal.view alone lists withdrawals.
    const viewerList = await server.inject({ method: "GET", url: "/api/shift-withdrawals", headers: { cookie: viewerCookie } });
    assert.equal(viewerList.statusCode, 200, viewerList.body);
    const listBody = viewerList.json() as { data: Array<{ id: string; code: string; notes: string | null }> };
    assert.ok(listBody.data.some((row) => row.id === withdrawal.id), "viewer sees the seeded withdrawal");

    // 2) and reads the detail with its lines.
    const viewerDetail = await server.inject({ method: "GET", url: "/api/shift-withdrawals/" + withdrawal.id, headers: { cookie: viewerCookie } });
    assert.equal(viewerDetail.statusCode, 200, viewerDetail.body);
    const detailBody = viewerDetail.json() as { data: { withdrawal: { id: string }; lines: Array<{ quantity: string | number }> } };
    assert.equal(detailBody.data.withdrawal.id, withdrawal.id);
    assert.equal(detailBody.data.lines.length, 1);
    assert.equal(Number(detailBody.data.lines[0].quantity), 5);

    // 3) warehouse.view keeps working (regression).
    const warehouseList = await server.inject({ method: "GET", url: "/api/shift-withdrawals", headers: { cookie: warehouseCookie } });
    assert.equal(warehouseList.statusCode, 200, warehouseList.body);
    const warehouseDetail = await server.inject({ method: "GET", url: "/api/shift-withdrawals/" + withdrawal.id, headers: { cookie: warehouseCookie } });
    assert.equal(warehouseDetail.statusCode, 200, warehouseDetail.body);

    // 4) No permission: 403 on both endpoints.
    const deniedList = await server.inject({ method: "GET", url: "/api/shift-withdrawals", headers: { cookie: outsiderCookie } });
    assert.equal(deniedList.statusCode, 403, deniedList.body);
    const deniedDetail = await server.inject({ method: "GET", url: "/api/shift-withdrawals/" + withdrawal.id, headers: { cookie: outsiderCookie } });
    assert.equal(deniedDetail.statusCode, 403, deniedDetail.body);

    // 5) View never grants create.
    const viewerCreate = await server.inject({
      method: "POST", url: "/api/shift-withdrawals", headers: { cookie: viewerCookie },
      payload: { shiftId: shift.id, employeeId: null, lines: [{ productId: product.id, warehouseId: warehouse.id, quantity: 1 }] }
    });
    assert.equal(viewerCreate.statusCode, 403, viewerCreate.body);
  } finally {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
