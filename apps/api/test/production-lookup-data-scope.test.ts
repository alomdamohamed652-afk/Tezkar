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

// Narrowed-role lookup bundle: after the shift_leader lockdown (29 grants, no
// orders.view/products.view/shifts.view/employees.lookup), the production and
// machine-production pages load master data through /api/production/lookup-data.
// The bundle must include order stages WITHOUT monetary fields (stage_rate,
// stage_rate_unit_id) while preserving stage_rate_method, and must accept
// machine_production holders too. Everyone else is denied.
test("production lookup-data serves narrowed roles order stages without monetary fields", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_lookup_" + randomBytes(6).toString("hex");
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
    process.env.SESSION_SECRET = "test-only-lookup-session-secret-long-enough";
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

    const suffix = randomBytes(4).toString("hex");
    const password = "Test-Lookup-2026!";
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

    // Exact final narrowed 29-grant shift_leader set from live prod (2026-11-25).
    const NARROWED_29 = [
      "account.change_password", "advances.view_own", "attendance.permission.request",
      "attendance.permission.view_own", "attendance.view_own", "cartons.create", "cartons.view",
      "deliveries.create", "deliveries.view", "earnings.view_own", "machine_production.create",
      "machine_production.view", "machines.view", "payment_requests.create", "payment_requests.view_own",
      "payroll.view_own", "production.create", "production.edit_own", "production.view",
      "production.view_own", "reverse_coding.print", "reverse_coding.scan", "reverse_coding.view",
      "tasks.comment", "tasks.update_own", "tasks.view_own", "warehouse.receipt.create",
      "warehouse.receipt.view", "warehouse.shift_withdrawal.create"
    ];

    const narrowed = await mkUser("narrowed-" + suffix);
    await grantPerms(narrowed.id, NARROWED_29);
    const machineOnly = await mkUser("machineonly-" + suffix);
    await grantPerms(machineOnly.id, ["machine_production.view", "machine_production.create"]);
    const managerUser = await mkUser("mgr-" + suffix);
    await grantPerms(managerUser.id, ["production.create", "orders.view"]);
    const noPerms = await mkUser("noperms-" + suffix);

    // Seed an active order with a priced stage so monetary stripping is exercised.
    const creator = await mkUser("creator-" + suffix);
    const order = (await apiPool!.query(
      "INSERT INTO production_orders(code,order_name,status,created_by) VALUES($1,$2,'IN_PROGRESS',$3) RETURNING id",
      ["ORD-T-" + suffix, "Lookup order", creator.id]
    )).rows[0];
    const stage = (await apiPool!.query("INSERT INTO stages(name) VALUES('Lookup stage') RETURNING id")).rows[0];
    const unit = (await apiPool!.query("SELECT id FROM units LIMIT 1")).rows[0];
    const product = (await apiPool!.query(
      "INSERT INTO products(name,product_type,unit_id) VALUES('Lookup product','FINISHED_GOOD',$1) RETURNING id",
      [unit.id]
    )).rows[0];
    await apiPool!.query(
      "INSERT INTO order_stages(order_id,stage_id,sequence_no,status,output_product_id,stage_rate,stage_rate_method,stage_rate_unit_id) VALUES($1,$2,1,'IN_PROGRESS',$3,42.5,'PER_1000',$4)",
      [order.id, stage.id, product.id, unit.id]
    );
    const rateGroup = (await apiPool!.query("INSERT INTO rate_groups(name) VALUES('Lookup rate group') RETURNING id")).rows[0];
    await apiPool!.query("INSERT INTO shifts(name,start_time,end_time,rate_group_id) VALUES('Lookup shift','08:00','16:00',$1)", [rateGroup.id]);
    await apiPool!.query("INSERT INTO employees(full_name) VALUES('Lookup Employee')");

    const narrowedCookie = await login("narrowed-" + suffix);
    const res = await server.inject({ method: "GET", url: "/api/production/lookup-data", headers: { cookie: narrowedCookie } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { data: {
      employees: unknown[]; orders: unknown[]; products: unknown[]; shifts: unknown[]; shiftLeaders: unknown[];
      orderStages: Array<Record<string, unknown>>;
    } };
    assert.ok(Array.isArray(body.data.employees) && body.data.employees.length > 0, "employees fallback data");
    assert.ok(Array.isArray(body.data.orders) && body.data.orders.length > 0, "orders fallback data");
    assert.ok(Array.isArray(body.data.products) && body.data.products.length > 0, "products fallback data");
    assert.ok(Array.isArray(body.data.shifts) && body.data.shifts.length > 0, "shifts fallback data");
    assert.ok(Array.isArray(body.data.orderStages), "orderStages present");
    const found = body.data.orderStages.find((os) => os.order_id === order.id);
    assert.ok(found, "seeded order stage returned for narrowed role");
    assert.equal(found.stage_rate_method, "PER_1000", "authoritative stage_rate_method preserved");
    assert.ok(!("stage_rate" in found), "monetary stage_rate never exposed");
    assert.ok(!("stage_rate_unit_id" in found), "stage_rate_unit_id never exposed");
    assert.equal(found.output_product_id, product.id);
    assert.equal(found.stage_name, "Lookup stage");
    assert.equal(found.order_name, "Lookup order");

    // Machine-production-only holder also served (machine page fallback path).
    const machineCookie = await login("machineonly-" + suffix);
    const resMachine = await server.inject({ method: "GET", url: "/api/production/lookup-data", headers: { cookie: machineCookie } });
    assert.equal(resMachine.statusCode, 200, resMachine.body);

    // Direct-path role (production.create) keeps working unchanged.
    const managerCookie = await login("mgr-" + suffix);
    const resMgr = await server.inject({ method: "GET", url: "/api/production/lookup-data", headers: { cookie: managerCookie } });
    assert.equal(resMgr.statusCode, 200, resMgr.body);

    // No relevant permission: denied.
    const noCookie = await login("noperms-" + suffix);
    const resDenied = await server.inject({ method: "GET", url: "/api/production/lookup-data", headers: { cookie: noCookie } });
    assert.equal(resDenied.statusCode, 403, resDenied.body);
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
