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
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()),
    "TEST_DATABASE_URL must point to a local disposable PostgreSQL test server"
  );
  assert.equal(
    url.pathname.slice(1),
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
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

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

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { payrollRoutes }, { hashPassword }, { authenticateRequest }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/payroll/payroll.routes.js"),
        import("../src/modules/auth/auth.service.js"),
        import("../src/modules/auth/auth.middleware.js"),
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

    let invalidSessionHandlerExecuted = false;
    app.get("/test/auth-only", { preHandler: [authenticateRequest] }, async () => {
      invalidSessionHandlerExecuted = true;
      return { ok: true };
    });

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

      const invalidSession = await app.inject({
        method: "GET", url: "/test/auth-only", headers: { cookie: "tezkar_session=invalid-session-token" }
      });
      assert.equal(invalidSession.statusCode, 401, invalidSession.body);
      assert.equal(invalidSessionHandlerExecuted, false, "invalid sessions must stop before route handlers run");

      const invalidMonthQuery = await app.inject({
        method: "GET", url: "/api/payroll?month=2099-13", headers: { cookie: cookieHeader }
      });
      assert.equal(invalidMonthQuery.statusCode, 422, invalidMonthQuery.body);

      const invalidMonthGenerate = await app.inject({
        method: "POST", url: "/api/payroll/generate", headers: { cookie: cookieHeader },
        payload: { month: "2099-00" }
      });
      assert.equal(invalidMonthGenerate.statusCode, 422, invalidMonthGenerate.body);

      const zeroYearGenerate = await app.inject({
        method: "POST", url: "/api/payroll/generate", headers: { cookie: cookieHeader },
        payload: { month: "0000-01" }
      });
      assert.equal(zeroYearGenerate.statusCode, 422, zeroYearGenerate.body);

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

      // Payroll approval must create exactly one accounting expense per non-zero payroll item.
      const linkedPayroll = await apiPool.query(
        "SELECT i.id,i.accounting_expense_id,i.net_amount,e.category,e.amount,e.payment_method,e.expense_date::text AS expense_date " +
        "FROM payroll_items i LEFT JOIN accounting_expenses e ON e.id=i.accounting_expense_id WHERE i.period_id=$1 ORDER BY i.id",
        [period.rows[0].id]
      );
      assert.equal(linkedPayroll.rowCount, 2);
      assert.ok(linkedPayroll.rows.every((row: {accounting_expense_id:string|null;category:string|null}) =>
        row.accounting_expense_id && row.category === "SALARIES"));
      assert.ok(linkedPayroll.rows.every((row: {amount:string;net_amount:string;payment_method:string;expense_date:string}) =>
        Number(row.amount) === Number(row.net_amount) && row.payment_method === "PAYROLL" &&
        String(row.expense_date).slice(0,10) === "2099-01-01"));
      const secondApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${period.rows[0].id}/approve`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(secondApproval.statusCode, 409, secondApproval.body);
      assert.equal(secondApproval.json().error.code, "PAYROLL_PERIOD_LOCKED");
      const salaryExpenseCount = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM accounting_expenses WHERE category='SALARIES' AND payment_method='PAYROLL' AND expense_date='2099-01-01'"
      );
      assert.equal(salaryExpenseCount.rows[0].count, 2, "re-approval must not duplicate salary expenses");

      // A fixed monthly advance installment is previewed in a draft payroll, then
      // recorded exactly once when that payroll is approved.
      const fixedAdvance = await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,installment_amount,repayment_status)
         VALUES($1,800,'Fixed installment integration test','PAID',$2,$2,'2099-01-15T12:00:00Z','FIXED_INSTALLMENT',300,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      const februaryGenerate = await app.inject({
        method: "POST", url: "/api/payroll/generate", headers: { cookie: cookieHeader },
        payload: { month: "2099-02" }
      });
      assert.equal(februaryGenerate.statusCode, 201, februaryGenerate.body);
      const februaryData = await app.inject({
        method: "GET", url: "/api/payroll?month=2099-02", headers: { cookie: cookieHeader }
      });
      assert.equal(februaryData.statusCode, 200, februaryData.body);
      const februaryItem = februaryData.json().data.items.find((row: {employee_id:string}) => row.employee_id === employeeA.rows[0].id);
      assert.ok(februaryItem, "employee with a salary profile should be included in the February payroll");
      assert.equal(Number(februaryItem.advance_repayment_amount), 300);
      assert.equal(Number(februaryItem.net_amount), 700, "fixed installment reduces employee take-home pay");
      const februaryApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${februaryData.json().data.period.id}/approve`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(februaryApproval.statusCode, 200, februaryApproval.body);
      const fixedRepayment = await apiPool.query(
        "SELECT amount,repayment_type,source_payroll_item_id FROM advance_repayments WHERE advance_id=$1",
        [fixedAdvance.rows[0].id]
      );
      assert.equal(fixedRepayment.rowCount, 1);
      assert.equal(Number(fixedRepayment.rows[0].amount), 300);
      assert.equal(fixedRepayment.rows[0].repayment_type, "FIXED_INSTALLMENT");
      assert.equal(fixedRepayment.rows[0].source_payroll_item_id, februaryItem.id);
      const fixedBalance = await apiPool.query(
        "SELECT repayment_status,amount-(SELECT COALESCE(SUM(ar.amount),0) FROM advance_repayments ar WHERE ar.advance_id=advance_requests.id) AS remaining FROM advance_requests WHERE id=$1",
        [fixedAdvance.rows[0].id]
      );
      assert.equal(fixedBalance.rows[0].repayment_status, "OPEN");
      assert.equal(Number(fixedBalance.rows[0].remaining), 500);
      const duplicateFebruaryApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${februaryData.json().data.period.id}/approve`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(duplicateFebruaryApproval.statusCode, 409);
      assert.equal(duplicateFebruaryApproval.json().error.code, "PAYROLL_PERIOD_LOCKED");
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[fixedAdvance.rows[0].id])).rows[0].count,1);

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
