import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("order stage reorder: permutation, validation, locks, audit", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  const url0 = new URL(adminUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url0.hostname.toLowerCase()), "TEST_DATABASE_URL must point to local disposable PostgreSQL");
  assert.equal(url0.pathname.slice(1), "postgres");
  const dbName = "tezkar_reorder_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally { await admin.end(); }
  const target = new URL(adminUrl);
  target.pathname = "/" + dbName;
  let apiPool: typeof import("../src/db/pool.js").pool | undefined;
  let app: import("fastify").FastifyInstance | undefined;
  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], { cwd: apiDir, env: { ...process.env, DATABASE_URL: target.toString() }, encoding: "utf8" });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);
    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-reorder-session-secret-000000";
    process.env.NODE_ENV = "test";
    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { orderRoutes }, { hashPassword }, poolModule] = await Promise.all([
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

    async function makeUser(label: string, manager: boolean) {
      const username = label + "-" + randomBytes(5).toString("hex");
      const user = await apiPool!.query("INSERT INTO users(username,password_hash,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,TRUE,FALSE,FALSE) RETURNING id", [username, hashPassword("Test-only-password-2026!")]);
      if (manager) {
        await apiPool!.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING", [user.rows[0].id]);
        await apiPool!.query("INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING");
      } else {
        const role = await apiPool!.query("INSERT INTO roles(code,name,is_active) VALUES('no_stage_perm','no_stage_perm',TRUE) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id");
        await apiPool!.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [user.rows[0].id, role.rows[0].id]);
        await apiPool!.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code='orders.view' ON CONFLICT DO NOTHING", [role.rows[0].id]);
      }
      const login = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "Test-only-password-2026!" } });
      assert.equal(login.statusCode, 200, login.body);
      const setCookie = login.headers["set-cookie"];
      return { cookie: (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0] };
    }
    const manager = await makeUser("manager", true);
    const viewer = await makeUser("viewer", false);

    const created = await app.inject({
      method: "POST", url: "/api/orders", headers: { cookie: manager.cookie },
      payload: { orderName: "طلبية ترتيب", stages: [
        { stageName: "قص", outputProductName: "منتج ا", sequenceNo: 1, plannedQuantity: 100 },
        { stageName: "كبس", outputProductName: "منتج ب", sequenceNo: 2, plannedQuantity: 100 },
        { stageName: "تعبئة", outputProductName: "منتج ج", sequenceNo: 3, plannedQuantity: 100 }
      ] }
    });
    assert.equal(created.statusCode, 201, created.body);
    const orderId = created.json().data.id as string;
    const order = async () => (await apiPool!.query("SELECT id,sequence_no FROM order_stages WHERE order_id=$1 ORDER BY sequence_no", [orderId])).rows.map(r => ({ id: r.id as string, n: Number(r.sequence_no) }));
    const [a, b, c] = (await order()).map(r => r.id);
    const post = (ck: string, ids: string[], oid = orderId) => app!.inject({ method: "POST", url: `/api/orders/${oid}/stages/reorder`, headers: { cookie: ck }, payload: { stageIds: ids } });

    await apiPool.query("UPDATE order_stages SET is_final_product=FALSE WHERE order_id=$1", [orderId]);
    // permission
    assert.equal((await post(viewer.cookie, [c, a, b])).statusCode, 403);
    assert.deepEqual((await order()).map(r => r.id), [a, b, c]);

    // move last to first
    const ok = await post(manager.cookie, [c, a, b]);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().data.changed, true);
    assert.equal(ok.json().data.implicit_final_changed, true);
    assert.deepEqual(await order(), [{ id: c, n: 1 }, { id: a, n: 2 }, { id: b, n: 3 }]);

    // same order = no-op, no extra audit
    const auditBefore = Number((await apiPool.query("SELECT count(*) FROM audit_log WHERE entity_id=$1 AND after_data ? 'stage_order'", [orderId])).rows[0].count);
    const same = await post(manager.cookie, [c, a, b]);
    assert.equal(same.json().data.changed, false);
    const auditAfter = Number((await apiPool.query("SELECT count(*) FROM audit_log WHERE entity_id=$1 AND after_data ? 'stage_order'", [orderId])).rows[0].count);
    assert.equal(auditAfter, auditBefore);
    assert.equal(auditBefore, 1);

    // validation
    assert.equal((await post(manager.cookie, [c, a])).statusCode, 409);
    assert.equal((await post(manager.cookie, [c, a, a])).statusCode, 422);
    assert.equal((await post(manager.cookie, [c, a, "00000000-0000-4000-8000-000000000000"])).statusCode, 409);
    assert.deepEqual((await order()).map(r => r.id), [c, a, b]);

    // completed / cancelled orders are locked
    await apiPool.query("UPDATE production_orders SET status='COMPLETED' WHERE id=$1", [orderId]);
    assert.equal((await post(manager.cookie, [a, b, c])).statusCode, 409);
    await apiPool.query("UPDATE production_orders SET status='CANCELLED' WHERE id=$1", [orderId]);
    assert.equal((await post(manager.cookie, [a, b, c])).statusCode, 409);
    assert.deepEqual((await order()).map(r => r.id), [c, a, b]);
  } finally {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await cleanup.end(); }
  }
});
