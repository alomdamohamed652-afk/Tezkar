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
    process.env.SESSION_SECRET = "test-only-sidebar-count-session-secret";
    process.env.NODE_ENV = "test";

    const [
      { default: Fastify },
      { default: cookie },
      { authRoutes },
      { taskRoutes },
      { paymentsRoutes },
      { notificationRoutes },
      { hashPassword },
      poolModule
    ] = await Promise.all([
      import("fastify"),
      import("@fastify/cookie"),
      import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/tasks/tasks.routes.js"),
      import("../src/modules/payments/payments.routes.js"),
      import("../src/modules/notifications/notifications.routes.js"),
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
    await app.register(taskRoutes);
    await app.register(paymentsRoutes);
    await app.register(notificationRoutes);

    const managerEmployee = (await apiPool.query(
      "INSERT INTO employees(full_name) VALUES('Sidebar Count Manager') RETURNING id"
    )).rows[0];
    const workerEmployee = (await apiPool.query(
      "INSERT INTO employees(full_name) VALUES('Sidebar Count Worker') RETURNING id"
    )).rows[0];
    const otherEmployee = (await apiPool.query(
      "INSERT INTO employees(full_name) VALUES('Sidebar Count Other Worker') RETURNING id"
    )).rows[0];
    const thirdEmployee = (await apiPool.query(
      "INSERT INTO employees(full_name) VALUES('Sidebar Count Third Worker') RETURNING id"
    )).rows[0];

    const manager = (await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      ["sidebar-manager-" + randomBytes(4).toString("hex"), hashPassword("Test-Manager-Password-2026!"), managerEmployee.id]
    )).rows[0];
    const worker = (await apiPool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      ["sidebar-worker-" + randomBytes(4).toString("hex"), hashPassword("Test-Worker-Password-2026!"), workerEmployee.id]
    )).rows[0];
    const unlinkedReader = (await apiPool.query(
      "INSERT INTO users(username,password_hash,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,TRUE,FALSE,FALSE) RETURNING id",
      ["sidebar-unlinked-" + randomBytes(4).toString("hex"), hashPassword("Test-Unlinked-Password-2026!")]
    )).rows[0];

    await apiPool.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager'",
      [manager.id]
    );
    await apiPool.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='worker'",
      [worker.id]
    );
    await apiPool.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='read_only'",
      [unlinkedReader.id]
    );

    const openTask = (await apiPool.query(
      "INSERT INTO tasks(title,created_by,status) VALUES('Worker open task',$1,'OPEN') RETURNING id",
      [manager.id]
    )).rows[0];
    await apiPool.query("INSERT INTO task_assignees(task_id,employee_id,assigned_by) VALUES($1,$2,$3)",
      [openTask.id, workerEmployee.id, manager.id]);
    await apiPool.query(
      "INSERT INTO tasks(title,created_by,status) VALUES('Manager in progress task',$1,'IN_PROGRESS') RETURNING id",
      [manager.id]
    );
    const completedTask = (await apiPool.query(
      "INSERT INTO tasks(title,created_by,status) VALUES('Worker completed task',$1,'COMPLETED') RETURNING id",
      [manager.id]
    )).rows[0];
    await apiPool.query("INSERT INTO task_assignees(task_id,employee_id,assigned_by) VALUES($1,$2,$3)",
      [completedTask.id, workerEmployee.id, manager.id]);
    const cancelledTask = (await apiPool.query(
      "INSERT INTO tasks(title,created_by,status) VALUES('Worker cancelled task',$1,'CANCELLED') RETURNING id",
      [manager.id]
    )).rows[0];
    await apiPool.query("INSERT INTO task_assignees(task_id,employee_id,assigned_by) VALUES($1,$2,$3)",
      [cancelledTask.id, workerEmployee.id, manager.id]);

    const paymentRows = [
      [workerEmployee.id, "PENDING", null],
      [workerEmployee.id, "REJECTED", manager.id],
      [workerEmployee.id, "PAID", manager.id],
      [otherEmployee.id, "APPROVED", manager.id],
      [thirdEmployee.id, "APPROVED", manager.id],
      [otherEmployee.id, "CANCELLED", null],
      [otherEmployee.id, "PAID", manager.id]
    ] as const;
    for (const [employeeId, status, reviewedBy] of paymentRows) {
      await apiPool.query(
        "INSERT INTO payment_requests(employee_id,amount,method,status,requested_by,reviewed_by,reviewed_at) VALUES($1,100,'CASH',$2,$3,$4,CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END)",
        [employeeId, status, worker.id, reviewedBy]
      );
    }

    await apiPool.query(
      "INSERT INTO user_notifications(user_id,type,title,message) VALUES($1,'TEST','Worker unread 1','Unread'),($1,'TEST','Worker unread 2','Unread'),($2,'TEST','Manager unread','Unread')",
      [worker.id, manager.id]
    );
    await apiPool.query(
      "UPDATE user_notifications SET read_at=now() WHERE user_id=$1 AND title='Worker unread 2'",
      [worker.id]
    );

    async function login(username: string, password: string) {
      const response = await app!.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username, password }
      });
      assert.equal(response.statusCode, 200, response.body);
      const setCookie = response.headers["set-cookie"];
      assert.ok(setCookie);
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    }

    const [managerCookie, workerCookie, unlinkedCookie] = await Promise.all([
      login((await apiPool.query("SELECT username FROM users WHERE id=$1", [manager.id])).rows[0].username, "Test-Manager-Password-2026!"),
      login((await apiPool.query("SELECT username FROM users WHERE id=$1", [worker.id])).rows[0].username, "Test-Worker-Password-2026!"),
      login((await apiPool.query("SELECT username FROM users WHERE id=$1", [unlinkedReader.id])).rows[0].username, "Test-Unlinked-Password-2026!")
    ]);

    const unauthenticatedTasks = await app.inject({ method: "GET", url: "/api/tasks/pending-count" });
    assert.equal(unauthenticatedTasks.statusCode, 401);
    const unauthenticatedNotifications = await app.inject({ method: "GET", url: "/api/notifications/unread-count" });
    assert.equal(unauthenticatedNotifications.statusCode, 401);

    const [managerTasks, workerTasks, unlinkedTasks, managerPayments, workerPayments, managerNotifications, workerNotifications] = await Promise.all([
      app.inject({ method: "GET", url: "/api/tasks/pending-count", headers: { cookie: managerCookie } }),
      app.inject({ method: "GET", url: "/api/tasks/pending-count", headers: { cookie: workerCookie } }),
      app.inject({ method: "GET", url: "/api/tasks/pending-count", headers: { cookie: unlinkedCookie } }),
      app.inject({ method: "GET", url: "/api/payment-requests/pending-count", headers: { cookie: managerCookie } }),
      app.inject({ method: "GET", url: "/api/payment-requests/pending-count", headers: { cookie: workerCookie } }),
      app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie: managerCookie } }),
      app.inject({ method: "GET", url: "/api/notifications/unread-count", headers: { cookie: workerCookie } })
    ]);

    assert.equal(managerTasks.statusCode, 200, managerTasks.body);
    assert.deepEqual(managerTasks.json(), { data: { count: 2 } },
      "manager sees all non-completed, non-cancelled tasks");
    assert.equal(workerTasks.statusCode, 200, workerTasks.body);
    assert.deepEqual(workerTasks.json(), { data: { count: 1 } },
      "worker sees only assigned non-completed, non-cancelled tasks");
    assert.equal(unlinkedTasks.statusCode, 403,
      "unlinked own-scope reader cannot receive a global task count");

    assert.equal(managerPayments.statusCode, 200, managerPayments.body);
    assert.deepEqual(managerPayments.json(), { data: { count: 3 } },
      "manager sees all pending and approved payment requests");
    assert.equal(workerPayments.statusCode, 200, workerPayments.body);
    assert.deepEqual(workerPayments.json(), { data: { count: 1 } },
      "worker sees only their single open payment request");

    assert.equal(managerNotifications.statusCode, 200, managerNotifications.body);
    assert.deepEqual(managerNotifications.json(), { data: { count: 1 } },
      "manager unread count is isolated to the manager account");
    assert.equal(workerNotifications.statusCode, 200, workerNotifications.body);
    assert.deepEqual(workerNotifications.json(), { data: { count: 1 } },
      "worker unread count excludes read notifications and other users' notifications");

    for (const response of [managerTasks, workerTasks, managerPayments, workerPayments, managerNotifications, workerNotifications]) {
      assert.deepEqual(Object.keys(response.json()), ["data"]);
      assert.deepEqual(Object.keys(response.json().data), ["count"],
        "Sidebar endpoints return only a compact count, never list rows");
    }

    assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM tasks WHERE status NOT IN ('COMPLETED','CANCELLED')")).rows[0].count), 2);
    assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM payment_requests WHERE status IN ('PENDING','APPROVED')")).rows[0].count), 3);
    assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM user_notifications WHERE user_id=$1 AND read_at IS NULL", [worker.id])).rows[0].count), 1);
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
