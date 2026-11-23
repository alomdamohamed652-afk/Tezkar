import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertDisposableDatabaseUrl(value: string) {
  const url = new URL(value);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL server");
  assert.equal(url.pathname.slice(1), "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres");
}

test("Administrative settlement and account-health scan", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);

  const databaseName = "tezkar_account_health_" + randomBytes(6).toString("hex");
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
    process.env.SESSION_SECRET = "test-only-account-health-session-secret";
    process.env.NODE_ENV = "test";

    const [
      { default: Fastify },
      { default: cookie },
      { authRoutes },
      { accountHealthRoutes },
      { administrativeSettlementRoutes },
      { hashPassword },
      poolModule
    ] = await Promise.all([
      import("fastify"),
      import("@fastify/cookie"),
      import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/account-health/account-health.routes.js"),
      import("../src/modules/account-health/administrative-settlement.routes.js"),
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
    await app.register(accountHealthRoutes);
    await app.register(administrativeSettlementRoutes);

    const mk = async (name: string, role: string, active = true) => {
      const employee = (await apiPool!.query("INSERT INTO employees(full_name,is_active) VALUES($1,$2) RETURNING id,code", [name, active])).rows[0];
      const username = name.toLowerCase().replace(/ /g, "-") + "-" + randomBytes(3).toString("hex");
      const user = (await apiPool!.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [username, hashPassword("Test-Password-2026!"), employee.id]
      )).rows[0];
      await apiPool!.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2", [user.id, role]);
      return { employee, user, username };
    };
    const login = async (username: string) => {
      const response = await app!.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "Test-Password-2026!" } });
      assert.equal(response.statusCode, 200, response.body);
      const setCookie = response.headers["set-cookie"];
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie as string).split(";")[0];
    };
    const manager = await mk("Health Manager", "manager");
    const worker = await mk("Health Worker", "worker");
    const negativeWorker = await mk("Negative Worker", "worker");
    const inactiveWorker = await mk("Inactive Worker", "worker", false);
    const managerCookie = await login(manager.username);
    const workerCookie = await login(worker.username);

    // Negative balance of 12.3457 (4 decimals) and a positive sub-cent style residual on the inactive worker.
    await apiPool.query("INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,notes,created_by) VALUES($1,'ADJUSTMENT',12.3457,'test debit',$2)", [negativeWorker.employee.id, manager.user.id]);
    await apiPool.query("INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,notes,created_by) VALUES($1,'ADJUSTMENT',0.0043,'test residual',$2)", [inactiveWorker.employee.id, manager.user.id]);

    // Scan: permission required, read-only, finds both.
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/account-health", headers: { cookie: workerCookie } })).statusCode, 403);
    const scan = await app.inject({ method: "GET", url: "/api/admin/account-health", headers: { cookie: managerCookie } });
    assert.equal(scan.statusCode, 200, scan.body);
    const checks = scan.json().data.checks as Array<{ code: string; findings: Array<{ employeeCode: string; amount: string }> }>;
    assert.deepEqual(checks.map(c => c.code), ["NEGATIVE_BALANCE", "ROUNDING_DRIFT", "STALE_ALLOCATIONS_AFTER_REVERSAL", "CANCELLED_PAID_PRODUCTION", "PARTIAL_PAYMENT_HANGING", "CUSTODY_MISMATCH"]);
    assert.ok(checks[0].findings.some(f => f.employeeCode === negativeWorker.employee.code && f.amount === "-12.3457"));
    assert.ok(checks[1].findings.some(f => f.employeeCode === inactiveWorker.employee.code && f.amount === "0.0043"));
    const ledgerCountBeforeSettle = Number((await apiPool.query("SELECT COUNT(*)::int AS n FROM employee_earnings_ledger")).rows[0].n);

    // Preview.
    const preview = await app.inject({ method: "GET", url: `/api/production/earnings/administrative-settlement/${negativeWorker.employee.id}`, headers: { cookie: managerCookie } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().data.balance, "-12.3457");
    assert.equal(preview.json().data.direction, "CREDIT");
    assert.equal(preview.json().data.amount, "12.3457");
    assert.equal((await app.inject({ method: "GET", url: `/api/production/earnings/administrative-settlement/${negativeWorker.employee.id}`, headers: { cookie: workerCookie } })).statusCode, 403);

    const key = randomUUID();
    const payload = { employeeId: negativeWorker.employee.id, expectedBalance: "-12.3457", reason: "رصيد تاريخي لا يُسترد", confirmEmployeeCode: negativeWorker.employee.code, acknowledgeNonCash: true, idempotencyKey: key };
    const post = (p: object, cookie = managerCookie) => app!.inject({ method: "POST", url: "/api/production/earnings/administrative-settlement", headers: { cookie }, payload: p });
    assert.equal((await post({ ...payload, reason: "x" })).statusCode, 422, "reason is mandatory");
    assert.equal((await post({ ...payload, acknowledgeNonCash: false })).statusCode, 422);
    assert.equal((await post({ ...payload, confirmEmployeeCode: "WRONG" })).statusCode, 409);
    assert.equal((await post({ ...payload, expectedBalance: "-12.0000" })).statusCode, 409, "stale expected balance is rejected");
    assert.equal((await post(payload, workerCookie)).statusCode, 403);
    const done = await post(payload);
    assert.equal(done.statusCode, 201, done.body);
    assert.equal(done.json().data.balanceAfter, "0.0000");
    assert.equal(done.json().data.amount, "12.3457");
    const replay = await post(payload);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.idempotentReplay, true);
    assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS n FROM employee_earnings_ledger")).rows[0].n), ledgerCountBeforeSettle + 1, "double submit must write one ledger row");
    assert.equal(Number((await apiPool.query("SELECT COALESCE(SUM(credit_amount-debit_amount),0)::float8 AS b FROM employee_earnings_ledger WHERE employee_id=$1", [negativeWorker.employee.id])).rows[0].b), 0);
    assert.equal((await post({ ...payload, idempotencyKey: randomUUID(), expectedBalance: "0" })).statusCode, 409, "zero balance has nothing to settle");
    const audit = await apiPool.query("SELECT before_data,after_data FROM audit_log WHERE module='ADMIN' AND action='administrative_settlement'");
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].before_data.balance, "-12.3457");
    assert.equal(audit.rows[0].after_data.balance, "0.0000");

    // Inactive worker: explicit acknowledgement, stays inactive.
    const inactivePayload = { employeeId: inactiveWorker.employee.id, expectedBalance: "0.0043", reason: "بقية تقريب لعامل غير نشط", confirmEmployeeCode: inactiveWorker.employee.code, acknowledgeNonCash: true, idempotencyKey: randomUUID() };
    assert.equal((await post(inactivePayload)).statusCode, 409, "inactive worker needs explicit acknowledgement");
    assert.equal((await post({ ...inactivePayload, acknowledgeInactive: true })).statusCode, 201);
    assert.equal((await apiPool.query("SELECT is_active FROM employees WHERE id=$1", [inactiveWorker.employee.id])).rows[0].is_active, false, "the worker must not be reactivated");

    const rescan = (await app.inject({ method: "GET", url: "/api/admin/account-health", headers: { cookie: managerCookie } })).json().data.checks;
    assert.equal(rescan[0].findings.length, 0);
  } finally {
    if (app) await app.close().catch(() => {});
    if (apiPool) await apiPool.end().catch(() => {});
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
