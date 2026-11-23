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
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:",
    "TEST_DATABASE_URL must use PostgreSQL");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres");
}

test("machine production route serializes concurrent same-key submissions", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl, "TEST_DATABASE_URL must point to a disposable PostgreSQL test server");
  assertDisposableDatabaseUrl(adminUrl);

  const databaseName = "tezkar_machine_production_" + randomBytes(6).toString("hex");
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
      { orderRoutes },
      { hashPassword },
      poolModule
    ] = await Promise.all([
      import("fastify"),
      import("@fastify/cookie"),
      import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/orders/orders.routes.js"),
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
    await app.register(orderRoutes);

    const employee = await apiPool.query(
      "INSERT INTO employees(full_name) VALUES ('Machine production concurrency test') RETURNING id"
    );
    const password = "Test-Only-Password-2026!";
    const username = "machine-production-" + randomBytes(5).toString("hex");
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
      ["Machine production concurrency " + randomBytes(4).toString("hex"), unit.rows[0].id]
    );
    const machine = await apiPool.query(
      "INSERT INTO machines(name,machine_type) VALUES ($1,'TEST') RETURNING id",
      ["Concurrency machine " + randomBytes(4).toString("hex")]
    );
    const warehouse = await apiPool.query("INSERT INTO warehouses(name) VALUES ('Machine production concurrency') RETURNING id");
    const location = await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES ($1,'A','General') RETURNING id",
      [warehouse.rows[0].id]
    );

    const idempotencyKey = randomUUID();
    const payload = {
      machineId: machine.rows[0].id,
      productId: product.rows[0].id,
      workDate: "2099-01-08",
      quantity: 2,
      warehouseId: warehouse.rows[0].id,
      locationId: location.rows[0].id,
      idempotencyKey
    };
    const concurrentRuns = await Promise.all([1, 2].map(() => app!.inject({
      method: "POST",
      url: "/api/machine-production",
      headers: { cookie: cookieHeader },
      payload
    })));
    assert.deepEqual(concurrentRuns.map((response) => response.statusCode).sort(), [200, 201],
      "concurrent same-key machine production must return one create and one replay, not a database error: " +
      concurrentRuns.map((response) => response.statusCode + ": " + response.body).join("\n"));
    const replayedRun = concurrentRuns.find((response) => response.statusCode === 200)!;
    const createdRun = concurrentRuns.find((response) => response.statusCode === 201)!;
    assert.equal(createdRun.json().idempotentReplay, false);
    assert.equal(replayedRun.json().idempotentReplay, true,
      "the second same-key response must be marked as an idempotent replay");
    assert.equal(replayedRun.json().data.id, createdRun.json().data.id,
      "both responses must reference the same machine production");
    const productionCount = await apiPool.query(
      "SELECT COUNT(*)::int AS count FROM machine_productions WHERE idempotency_key=$1",
      [idempotencyKey]
    );
    assert.equal(productionCount.rows[0].count, 1,
      "concurrent same-key submissions must create exactly one machine production");

    const changedPayload = await app.inject({
      method: "POST",
      url: "/api/machine-production",
      headers: { cookie: cookieHeader },
      payload: { ...payload, quantity: 3 }
    });
    assert.equal(changedPayload.statusCode, 409, changedPayload.body);
    assert.equal(changedPayload.json().error.code, "IDEMPOTENCY_KEY_REUSED");
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
