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
  assert.equal(url.pathname.slice(1), "postgres",
    "test DB admin connection must target disposable admin database postgres");
}

test("cash custody API enforces employee scope, duplicate confirmation, balance and audit trail", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_cash_custody_api_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = "/" + name;
  let apiPool: typeof import("../src/db/pool.js").pool | undefined;
  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir, env: { ...process.env, DATABASE_URL: target.toString() }, encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-cash-custody-session-secret";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { custodyRoutes },
      { hashPassword }, poolModule] = await Promise.all([
      import("fastify"), import("@fastify/cookie"),
      import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/custody/custody.routes.js"),
      import("../src/modules/auth/auth.service.js"),
      import("../src/db/pool.js")
    ]);
    apiPool = poolModule.pool;
    const app = Fastify();
    await app.register(cookie, { secret: process.env.SESSION_SECRET });
    app.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await app.register(authRoutes);
    await app.register(custodyRoutes);

    try {
      const employeeA = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Cash Custody Test Employee A') RETURNING id"
      )).rows[0];
      const employeeB = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Cash Custody Test Employee B') RETURNING id"
      )).rows[0];
      const workerUsername = "cashwrk-" + randomBytes(4).toString("hex");
      const managerUsername = "cashmgr-" + randomBytes(4).toString("hex");
      const workerPassword = "Test-Cash-Worker-2026!";
      const managerPassword = "Test-Cash-Manager-2026!";
      const worker = (await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [workerUsername, hashPassword(workerPassword), employeeA.id]
      )).rows[0];
      const manager = (await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [managerUsername, hashPassword(managerPassword), employeeB.id]
      )).rows[0];
      const unprivilegedEmployee = (await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Cash Custody Unprivileged Employee') RETURNING id"
      )).rows[0];
      const unprivilegedUsername = "cashnoperm-" + randomBytes(4).toString("hex");
      const unprivilegedPassword = "Test-Cash-No-Permission-2026!";
      await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE)",
        [unprivilegedUsername, hashPassword(unprivilegedPassword), unprivilegedEmployee.id]
      );
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker' ON CONFLICT DO NOTHING",
        [worker.id]
      );
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
        [manager.id]
      );
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING"
      );
      // Keep the granted all-scope permissions but remove the finance role name.
      // Access scope must follow RBAC permissions, not a hard-coded list of role codes.
      await apiPool.query("UPDATE roles SET code='cash_supervisor_test' WHERE code='manager'");

      async function login(username: string, password: string) {
        const response = await app.inject({
          method: "POST", url: "/api/auth/login", payload: { username, password }
        });
        assert.equal(response.statusCode, 200, response.body);
        const setCookie = response.headers["set-cookie"];
        assert.ok(setCookie);
        return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
      }

      const workerCookie = await login(workerUsername, workerPassword);
      const managerCookie = await login(managerUsername, managerPassword);
      const unprivilegedCookie = await login(unprivilegedUsername, unprivilegedPassword);

      const unauthenticated = await app.inject({ method: "GET", url: "/api/cash-custody" });
      assert.equal(unauthenticated.statusCode, 401);

      const forbiddenRead = await app.inject({
        method: "GET", url: "/api/cash-custody", headers: { cookie: unprivilegedCookie }
      });
      assert.equal(forbiddenRead.statusCode, 403, forbiddenRead.body);
      const forbiddenWrite = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: unprivilegedCookie },
        payload: {
          direction: "IN", amount: 999, transactionDate: "2099-01-10",
          description: "Must be blocked without cash custody permission"
        }
      });
      assert.equal(forbiddenWrite.statusCode, 403, forbiddenWrite.body);

      const ownIncoming = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "IN", amount: 100, transactionDate: "2099-01-10",
          description: "Test custody advance received"
        }
      });
      assert.equal(ownIncoming.statusCode, 201, ownIncoming.body);

      const ownOutgoing = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 30, transactionDate: "2099-01-10",
          description: "Test custody cash spent"
        }
      });
      assert.equal(ownOutgoing.statusCode, 201, ownOutgoing.body);

      const duplicate = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 30, transactionDate: "2099-01-10",
          description: "Accidental duplicate"
        }
      });
      assert.equal(duplicate.statusCode, 409, duplicate.body);
      assert.equal(duplicate.json().error.code, "DUPLICATE_CASH_CUSTODY");

      const confirmedDuplicate = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 30, transactionDate: "2099-01-10",
          description: "Intentionally repeated transaction", confirmDuplicate: true
        }
      });
      assert.equal(confirmedDuplicate.statusCode, 201, confirmedDuplicate.body);
      assert.equal(confirmedDuplicate.json().data.confirmed_duplicate, true);

      const concurrentDuplicates = await Promise.all([1, 2].map(index => app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          direction: "OUT", amount: 17, transactionDate: "2099-01-10",
          description: `Concurrent duplicate attempt ${index}`
        }
      })));
      assert.equal(concurrentDuplicates.filter(response => response.statusCode === 201).length, 1,
        concurrentDuplicates.map(response => `${response.statusCode}: ${response.body}`).join("\\n"));
      assert.equal(concurrentDuplicates.filter(response =>
        response.statusCode === 409 && response.json().error.code === "DUPLICATE_CASH_CUSTODY").length, 1);

      const outOfScope = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: workerCookie },
        payload: {
          employeeId: employeeB.id, direction: "IN", amount: 500,
          transactionDate: "2099-01-10", description: "Attempt to edit another employee"
        }
      });
      assert.equal(outOfScope.statusCode, 403, outOfScope.body);
      assert.equal(outOfScope.json().error.code, "OWN_SCOPE_ONLY");

      const workerRows = await app.inject({
        method: "GET", url: "/api/cash-custody", headers: { cookie: workerCookie }
      });
      assert.equal(workerRows.statusCode, 200, workerRows.body);
      assert.equal(workerRows.json().data.length, 4);
      assert.ok(workerRows.json().data.every((row: { employee_id: string }) => row.employee_id === employeeA.id));
      assert.deepEqual(
        workerRows.json().data.map((row: { balance: string }) => Number(row.balance)).sort((a: number, b: number) => a - b),
        [23, 40, 70, 100],
        "each transaction must show the running balance immediately after that movement"
      );

      const managerEntry = await app.inject({
        method: "POST", url: "/api/cash-custody", headers: { cookie: managerCookie },
        payload: {
          employeeId: employeeA.id, direction: "IN", amount: 25,
          transactionDate: "2099-01-11", description: "Manager records additional custody"
        }
      });
      assert.equal(managerEntry.statusCode, 201, managerEntry.body);

      const audit = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM audit_log WHERE module='cash_custody' AND entity_type='cash_custody_transaction' AND actor_user_id=$1",
        [worker.id]
      );
      assert.equal(audit.rows[0].count, 4, "all successfully created worker transactions must be audited");
    } finally {
      await app.close();
    }
  } finally {
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
});
