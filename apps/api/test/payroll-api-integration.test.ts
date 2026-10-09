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
  assert.ok(
    url.protocol === "postgres:" || url.protocol === "postgresql:",
    "TEST_DATABASE_URL must use PostgreSQL"
  );
  assert.ok(
    ["localhost", "127.0.0.1", "::1", "postgres"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server"
  );
  assert.equal(
    url.pathname.replace(/^\\/+/, ""),
    "postgres",
    "TEST_DATABASE_URL must use the disposable admin database named postgres"
  );
}

test("payroll HTTP routes enforce approval, partial/full payment, overpayment and concurrent payment safety", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl, "TEST_DATABASE_URL must point to a disposable PostgreSQL test server");
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_payroll_api_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const target = new URL(adminUrl);
  target.pathname = "/" + name;
  let apiPool: typeof import("../src/db/pool.js").pool | undefined;

  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    // Configure the API's singleton DB pool before importing route modules.
    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { payrollRoutes }, { hashPassword }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/payroll/payroll.routes.js"),
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
    await app.register(payrollRoutes);

    try {
      const employeeA = await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Payroll API Employee A') RETURNING id"
      );
      const employeeB = await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ('Payroll API Employee B') RETURNING id"
      );
      const password = "Test-Only-Password-2026!";
      const userResult = await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES ($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        ["payroll-api-" + randomBytes(5).toString("hex"), hashPassword(password), employeeA.rows[0].id]
      );
      const userId = userResult.rows[0].id;
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
        [userId]
      );
      // Ensure this synthetic manager has every permission, including payroll routes.
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING"
      );

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: (await apiPool.query("SELECT username FROM users WHERE id=$1", [userId])).rows[0].username, password }
      });
      assert.equal(login.statusCode, 200, login.body);
      const setCookie = login.headers["set-cookie"];
      assert.ok(setCookie, "login must issue a session cookie");
      const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];

      const unauthenticated = await app.inject({
        method: "POST", url: "/api/payroll/periods/00000000-0000-0000-0000-000000000000/approve"
      });
      assert.equal(unauthenticated.statusCode, 401);

      const period = await apiPool.query(
        "INSERT INTO payroll_periods(period_month,generated_by) VALUES ('2099-01-01',$1) RETURNING id",
        [userId]
      );
      const profileA = await apiPool.query(
        "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,1000,'2098-01-01',$2) RETURNING id",
        [employeeA.rows[0].id, userId]
      );
      const profileB = await apiPool.query(
        "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,1000,'2098-01-01',$2) RETURNING id",
        [employeeB.rows[0].id, userId]
      );
      const itemA = await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,1000,100,100) RETURNING id",
        [period.rows[0].id, employeeA.rows[0].id, profileA.rows[0].id]
      );
      const itemB = await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,1000,100,100) RETURNING id",
        [period.rows[0].id, employeeB.rows[0].id, profileB.rows[0].id]
      );

      const beforeApproval = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { amount: 100 }
      });
      assert.equal(beforeApproval.statusCode, 409, beforeApproval.body);
      assert.equal(beforeApproval.json().error.code, "PAYROLL_NOT_APPROVED");

      const approval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${period.rows[0].id}/approve`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(approval.statusCode, 200, approval.body);
      assert.equal(approval.json().data.status, "APPROVED");

      const partial = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { amount: 600, paymentMethod: "TEST" }
      });
      assert.equal(partial.statusCode, 201, partial.body);
      assert.equal(partial.json().data.status, "PARTIAL");
      assert.equal(Number(partial.json().data.remainingAmount), 400);

      const full = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { amount: 400, paymentMethod: "TEST" }
      });
      assert.equal(full.statusCode, 201, full.body);
      assert.equal(full.json().data.status, "PAID");
      assert.equal(Number(full.json().data.remainingAmount), 0);

      const overpay = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { amount: 0.01, paymentMethod: "TEST" }
      });
      assert.equal(overpay.statusCode, 409, overpay.body);
      assert.equal(overpay.json().error.code, "PAYROLL_OVERPAYMENT");

      const concurrent = await Promise.all([700, 700].map(amount => app.inject({
        method: "POST", url: `/api/payroll/items/${itemB.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { amount, paymentMethod: "TEST" }
      })));
      assert.equal(concurrent.filter(response => response.statusCode === 201).length, 1,
        concurrent.map(response => `${response.statusCode}: ${response.body}`).join("\n"));
      assert.equal(concurrent.filter(response => response.statusCode === 409 && response.json().error.code === "PAYROLL_OVERPAYMENT").length, 1);

      const totals = await apiPool.query(
        "SELECT i.id,i.status,i.net_amount,COALESCE(SUM(pp.amount),0) AS paid FROM payroll_items i LEFT JOIN payroll_payments pp ON pp.payroll_item_id=i.id WHERE i.id=ANY($1::uuid[]) GROUP BY i.id",
        [[itemA.rows[0].id, itemB.rows[0].id]]
      );
      const rowA = totals.rows.find(row => row.id === itemA.rows[0].id);
      const rowB = totals.rows.find(row => row.id === itemB.rows[0].id);
      assert.equal(Number(rowA.paid), 1000);
      assert.equal(Number(rowA.net_amount), 1000);
      assert.equal(rowA.status, "PAID");
      assert.equal(Number(rowB.paid), 700);
      assert.equal(Number(rowB.paid) <= Number(rowB.net_amount), true);

      const payments = await app.inject({
        method: "GET", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(payments.statusCode, 200, payments.body);
      assert.equal(payments.json().data.length, 2);
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
