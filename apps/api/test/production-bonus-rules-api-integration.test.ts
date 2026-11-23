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

test("production bonus rules: CRUD, audit and best-threshold selection", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_bonus_rules_" + randomBytes(6).toString("hex");
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

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { productionRoutes }, { productionBonusRuleRoutes, findAutoBonusRule }, { hashPassword }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/production/production.routes.js"),
        import("../src/modules/production/bonus-rules.routes.js"),
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
    await server.register(productionBonusRuleRoutes);

    const managerEmployee = (await apiPool.query("INSERT INTO employees(full_name) VALUES('Bonus Rules Manager') RETURNING id")).rows[0];
    const username = "bonusmgr-" + randomBytes(4).toString("hex");
    const password = "Test-Bonus-Manager-2026!";
    const manager = (await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      [username, hashPassword(password), managerEmployee.id]
    )).rows[0];
    await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager'", [manager.id]);
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
    assert.equal(login.statusCode, 200, login.body);
    const setCookie = login.headers["set-cookie"];
    const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0];
    const headers = { cookie: cookieHeader };

    const unit = (await apiPool.query("SELECT id FROM units WHERE code='PCS' LIMIT 1")).rows[0];
    const stage = (await apiPool.query("INSERT INTO stages(name) VALUES('Bonus rules stage') RETURNING id")).rows[0];
    const product = (await apiPool.query(
      "INSERT INTO products(name,product_type,unit_id) VALUES('Bonus rules product','FINISHED_GOOD',$1) RETURNING id", [unit.id])).rows[0];

    const bad = await server.inject({ method: "POST", url: "/api/production/bonus-rules", headers,
      payload: { name: "x", stageId: stage.id, minQuantity: 0, bonusAmount: 50, description: "d" } });
    assert.equal(bad.statusCode, 422, bad.body);

    const created = await server.inject({ method: "POST", url: "/api/production/bonus-rules", headers,
      payload: { name: "1500 bonus", stageId: stage.id, minQuantity: 1500, bonusAmount: 50, description: "بونص إنتاج 1500" } });
    assert.equal(created.statusCode, 201, created.body);
    const rule1 = created.json().data;
    const created2 = await server.inject({ method: "POST", url: "/api/production/bonus-rules", headers,
      payload: { name: "3000 bonus", stageId: stage.id, minQuantity: 3000, bonusAmount: 120, description: "بونص إنتاج 3000" } });
    assert.equal(created2.statusCode, 201, created2.body);

    const client = await apiPool.connect();
    try {
      assert.equal(await findAutoBonusRule(client, { stageId: stage.id, productId: product.id, quantity: 1499 }), null);
      assert.equal((await findAutoBonusRule(client, { stageId: stage.id, productId: product.id, quantity: 1500 }))?.bonus_amount, 50);
      assert.equal((await findAutoBonusRule(client, { stageId: stage.id, productId: product.id, quantity: 3100 }))?.bonus_amount, 120);
    } finally {
      client.release();
    }

    const patched = await server.inject({ method: "PATCH", url: "/api/production/bonus-rules/" + rule1.id, headers, payload: { isActive: false } });
    assert.equal(patched.statusCode, 200, patched.body);
    const client2 = await apiPool.connect();
    try {
      assert.equal(await findAutoBonusRule(client2, { stageId: stage.id, productId: product.id, quantity: 1600 }), null);
    } finally {
      client2.release();
    }

    const list = await server.inject({ method: "GET", url: "/api/production/bonus-rules", headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.length, 2);

    const del = await server.inject({ method: "DELETE", url: "/api/production/bonus-rules/" + rule1.id, headers });
    assert.equal(del.statusCode, 200, del.body);
    const audits = (await apiPool.query(
      "SELECT action FROM audit_log WHERE entity_type='production_bonus_rule' AND entity_id=$1 ORDER BY created_at", [rule1.id])).rows.map((r: any) => r.action);
    assert.deepEqual(audits, ["create", "edit", "delete"]);

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
