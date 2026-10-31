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

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { payrollRoutes }, { operationsMasterRoutes }, { advanceRoutes }, { accountingRoutes }, { hashPassword }, { authenticateRequest }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/payroll/payroll.routes.js"),
        import("../src/modules/operations-master/operations-master.routes.js"),
        import("../src/modules/advances/advances.routes.js"),
        import("../src/modules/accounting/accounting.routes.js"),
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
    await app.register(operationsMasterRoutes);
    await app.register(advanceRoutes);
    await app.register(accountingRoutes);

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
      const secondUserResult = await apiPool.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES ($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        ["payroll-api-reviewer-" + randomBytes(5).toString("hex"), hashPassword(password), employeeB.rows[0].id]
      );
      const secondUserId = secondUserResult.rows[0].id;
      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
        [userId]
      );
      // Ensure this synthetic manager has every permission, including payroll routes.
      await apiPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING"
      );
      await apiPool.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,description,created_by) VALUES($1,'IN',10000,'test opening custody for payroll payments',$2)",
        [employeeA.rows[0].id,userId]
      );

      await apiPool.query(
        "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 ON CONFLICT DO NOTHING",
        [secondUserId, "manager"]
      );
      const secondLogin = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: (await apiPool.query("SELECT username FROM users WHERE id=$1", [secondUserId])).rows[0].username, password }
      });
      assert.equal(secondLogin.statusCode, 200, secondLogin.body);
      const secondSetCookie = secondLogin.headers["set-cookie"];
      assert.ok(secondSetCookie, "reviewer login must issue a session cookie");
      const secondCookieHeader = (Array.isArray(secondSetCookie) ? secondSetCookie[0] : secondSetCookie).split(";")[0];

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

      // Multiple leaders may serve one shift, and the same employee may lead multiple shifts.
      const rateGroup = await apiPool.query(
        "INSERT INTO rate_groups(name) VALUES($1) RETURNING id",
        ["Shift test group " + randomBytes(4).toString("hex")]
      );
      async function createShift(name: string) {
        const response = await app.inject({
          method: "POST", url: "/api/shifts", headers: { cookie: cookieHeader },
          payload: { name, startTime: "08:00", endTime: "16:00", crossesMidnight: false, rateGroupId: rateGroup.rows[0].id }
        });
        assert.equal(response.statusCode, 201, response.body);
        return response.json().data.id as string;
      }
      const morningShift = await createShift("Morning test shift");
      const eveningShift = await createShift("Evening test shift");
      const leaderA = await app.inject({
        method: "POST", url: `/api/shifts/${morningShift}/leaders`, headers: { cookie: cookieHeader },
        payload: { employeeId: employeeA.rows[0].id }
      });
      assert.equal(leaderA.statusCode, 201, leaderA.body);
      const leaderB = await app.inject({
        method: "POST", url: `/api/shifts/${morningShift}/leaders`, headers: { cookie: cookieHeader },
        payload: { employeeId: employeeB.rows[0].id }
      });
      assert.equal(leaderB.statusCode, 201, leaderB.body, "a second leader must be allowed on the same shift");
      const sameEmployeeSecondShift = await app.inject({
        method: "POST", url: `/api/shifts/${eveningShift}/leaders`, headers: { cookie: cookieHeader },
        payload: { employeeId: employeeA.rows[0].id }
      });
      assert.equal(sameEmployeeSecondShift.statusCode, 201, sameEmployeeSecondShift.body);
      const employeeShiftList = await app.inject({
        method: "GET", url: `/api/employees/${employeeA.rows[0].id}/shifts`, headers: { cookie: cookieHeader }
      });
      assert.equal(employeeShiftList.statusCode, 200, employeeShiftList.body);
      assert.equal(employeeShiftList.json().data.length, 2, "the same employee may be assigned to multiple shifts");
      const leaderList = await app.inject({
        method: "GET", url: "/api/shift-leaders", headers: { cookie: cookieHeader }
      });
      assert.equal(leaderList.statusCode, 200, leaderList.body);
      assert.equal(leaderList.json().data.filter((row: {shift_id:string}) => row.shift_id === morningShift).length, 2);

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
        "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,1000,'2020-01-01',$2) RETURNING id",
        [employeeA.rows[0].id, userId]
      );
      const profileB = await apiPool.query(
        "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,1000,'2020-01-01',$2) RETURNING id",
        [employeeB.rows[0].id, userId]
      );
      const salaryHistory = await app.inject({
        method: "GET", url: `/api/payroll/employees/${employeeA.rows[0].id}/salary-history`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(salaryHistory.statusCode, 200, salaryHistory.body);
      assert.equal(salaryHistory.json().data.employee.id, employeeA.rows[0].id);
      assert.equal(salaryHistory.json().data.history.length, 1);
      assert.equal(Number(salaryHistory.json().data.history[0].monthly_salary), 1000);

      // Salary-based advance payout must appear as a debit on the employee account immediately.
      const ledgerBeforeSalaryAdvance = await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeB.rows[0].id]
      );
      const salaryAdvanceCreated = await app.inject({
        method: "POST", url: "/api/advances", headers: { cookie: cookieHeader },
        payload: { employeeId: employeeB.rows[0].id, amount: 250, reason: "Salary repayment integration test", repaymentMethod: "SALARY_PERCENTAGE", salaryPercentage: 10 }
      });
      assert.equal(salaryAdvanceCreated.statusCode, 201, salaryAdvanceCreated.body);
      const salaryAdvanceId = salaryAdvanceCreated.json().data.id as string;
      const salaryAdvanceApproved = await app.inject({
        method: "POST", url: "/api/advances/" + salaryAdvanceId + "/approve", headers: { cookie: secondCookieHeader }
      });
      assert.equal(salaryAdvanceApproved.statusCode, 200, salaryAdvanceApproved.body);
      const salaryAdvancePaid = await app.inject({
        method: "POST", url: "/api/advances/" + salaryAdvanceId + "/pay", headers: { cookie: secondCookieHeader }
      });
      assert.equal(salaryAdvancePaid.statusCode, 200, salaryAdvancePaid.body);
      assert.equal(salaryAdvancePaid.json().data.status, "PAID");
      assert.ok(salaryAdvancePaid.json().data.ledger_entry_id, "salary-based advance must debit the employee account so the negative balance is visible");
      const ledgerAfterSalaryAdvance = await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeB.rows[0].id]
      );
      assert.equal(Number(ledgerAfterSalaryAdvance.rows[0].balance), Number(ledgerBeforeSalaryAdvance.rows[0].balance)-250);
      const advanceCustodyOut=await apiPool.query("SELECT direction,amount FROM cash_custody_transactions WHERE source_type='ADVANCE_PAYOUT' AND source_id=$1",[salaryAdvanceId]);
      assert.equal(advanceCustodyOut.rowCount,1);
      assert.equal(advanceCustodyOut.rows[0].direction,"OUT");
      assert.equal(Number(advanceCustodyOut.rows[0].amount),250);
      const earlyRepayment=await app.inject({
        method:"POST",url:"/api/advances/"+salaryAdvanceId+"/repayments",headers:{cookie:secondCookieHeader},
        payload:{amount:50,repaymentType:"CUSTOM",notes:"early repayment integration test"}
      });
      assert.equal(earlyRepayment.statusCode,201,earlyRepayment.body);
      assert.equal(Number(earlyRepayment.json().data.remaining),200);
      const advanceCustodyIn=await apiPool.query("SELECT direction,amount FROM cash_custody_transactions WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",[earlyRepayment.json().data.repayment.id]);
      assert.equal(advanceCustodyIn.rowCount,1);
      assert.equal(advanceCustodyIn.rows[0].direction,"IN");
      assert.equal(Number(advanceCustodyIn.rows[0].amount),50);

      // A paid, still-open advance must not block another advance; payroll can repay both.
      const secondSalaryAdvanceCreated = await app.inject({
        method: "POST", url: "/api/advances", headers: { cookie: cookieHeader },
        payload: { employeeId: employeeB.rows[0].id, amount: 125, reason: "Second salary advance integration test", repaymentMethod: "SALARY_PERCENTAGE", salaryPercentage: 5 }
      });
      assert.equal(secondSalaryAdvanceCreated.statusCode, 201, secondSalaryAdvanceCreated.body);
      const secondSalaryAdvanceId = secondSalaryAdvanceCreated.json().data.id as string;
      const secondSalaryAdvanceApproved = await app.inject({
        method: "POST", url: "/api/advances/" + secondSalaryAdvanceId + "/approve", headers: { cookie: secondCookieHeader }
      });
      assert.equal(secondSalaryAdvanceApproved.statusCode, 200, secondSalaryAdvanceApproved.body);
      const secondSalaryAdvancePaid = await app.inject({
        method: "POST", url: "/api/advances/" + secondSalaryAdvanceId + "/pay", headers: { cookie: secondCookieHeader }
      });
      assert.equal(secondSalaryAdvancePaid.statusCode, 200, secondSalaryAdvancePaid.body);
      assert.ok(secondSalaryAdvancePaid.json().data.ledger_entry_id,"every advance payout must be posted to the employee account");
      const openPaidAdvances = await apiPool.query(
        "SELECT COUNT(*)::int AS count FROM advance_requests WHERE employee_id=$1 AND status='PAID' AND repayment_status='OPEN'",
        [employeeB.rows[0].id]
      );
      assert.equal(openPaidAdvances.rows[0].count, 2, "multiple salary advances may remain open for payroll repayment");

      // A fixed-installment advance cannot be paid until an effective salary profile exists.
      const employeeWithoutSalary = await apiPool.query(
        "INSERT INTO employees(full_name) VALUES ($1) RETURNING id", ["No Salary Profile Advance Test"]
      );
      const missingSalaryCreated = await app.inject({
        method: "POST", url: "/api/advances", headers: { cookie: cookieHeader },
        payload: { employeeId: employeeWithoutSalary.rows[0].id, amount: 100, reason: "Missing salary profile test", repaymentMethod: "FIXED_INSTALLMENT", installmentAmount: 25 }
      });
      assert.equal(missingSalaryCreated.statusCode, 201, missingSalaryCreated.body);
      const missingSalaryId = missingSalaryCreated.json().data.id as string;
      const missingSalaryApproved = await app.inject({
        method: "POST", url: "/api/advances/" + missingSalaryId + "/approve", headers: { cookie: secondCookieHeader }
      });
      assert.equal(missingSalaryApproved.statusCode, 200, missingSalaryApproved.body);
      const missingSalaryPay = await app.inject({
        method: "POST", url: "/api/advances/" + missingSalaryId + "/pay", headers: { cookie: secondCookieHeader }
      });
      assert.equal(missingSalaryPay.statusCode, 409, missingSalaryPay.body);
      assert.equal(missingSalaryPay.json().error.code, "SALARY_PROFILE_REQUIRED");
      const missingSalaryState = await apiPool.query("SELECT status,ledger_entry_id FROM advance_requests WHERE id=$1",[missingSalaryId]);
      assert.equal(missingSalaryState.rows[0].status, "APPROVED", "failed payout must roll back without changing advance status");
      assert.equal(missingSalaryState.rows[0].ledger_entry_id, null);

      const itemA = await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,1000,100,100) RETURNING id",
        [period.rows[0].id, employeeA.rows[0].id, profileA.rows[0].id]
      );
      const itemB = await apiPool.query(
        "INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,1000,100,100) RETURNING id",
        [period.rows[0].id, employeeB.rows[0].id, profileB.rows[0].id]
      );
      const adjustmentLines = await apiPool.query(
        `INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,created_by)
         VALUES ($1,'BONUS','Test bonus',100,$3),($1,'DEDUCTION','Test deduction',100,$3),
                ($2,'BONUS','Test bonus',100,$3),($2,'DEDUCTION','Test deduction',100,$3)
         RETURNING id`,
        [itemA.rows[0].id,itemB.rows[0].id,userId]
      );
      assert.equal(adjustmentLines.rowCount,4);

      const beforeApproval = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount: 100 }
      });
      assert.equal(beforeApproval.statusCode, 409, beforeApproval.body);
      assert.equal(beforeApproval.json().error.code, "PAYROLL_NOT_APPROVED");

      const attendanceSnapshot = Array.from({length:31},(_,index)=>{
        const date = `2099-01-${String(index+1).padStart(2,"0")}`;
        return [
          {date,employeeId:employeeA.rows[0].id,status:"PRESENT",firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,needsReview:false},
          {date,employeeId:employeeB.rows[0].id,status:"PRESENT",firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,needsReview:false}
        ];
      }).flat();
      const missingSnapshotApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${period.rows[0].id}/approve`,
        headers: { cookie: cookieHeader },
        payload: {}
      });
      assert.equal(missingSnapshotApproval.statusCode, 422, missingSnapshotApproval.body);
      assert.equal(missingSnapshotApproval.json().error.code, "ATTENDANCE_SNAPSHOT_REQUIRED");
      const incompleteSnapshotApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${period.rows[0].id}/approve`,
        headers: { cookie: cookieHeader },
        payload: { attendanceSnapshot: attendanceSnapshot.slice(0, 1) }
      });
      assert.equal(incompleteSnapshotApproval.statusCode, 422, incompleteSnapshotApproval.body);
      assert.equal(incompleteSnapshotApproval.json().error.code, "ATTENDANCE_SNAPSHOT_INCOMPLETE");
      const approval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${period.rows[0].id}/approve`,
        headers: { cookie: cookieHeader },
        payload: { attendanceSnapshot }
      });
      assert.equal(approval.statusCode, 200, approval.body);
      assert.equal(approval.json().data.status, "APPROVED");
      const reconciliation = await app.inject({
        method: "GET", url: "/api/accounting/reconciliation/payroll", headers: { cookie: cookieHeader }
      });
      assert.equal(reconciliation.statusCode, 200, reconciliation.body);
      assert.deepEqual(reconciliation.json().data.counts,{
        missingPayrollExpenses:0,
        missingAdjustmentLedgerEntries:0,
        cashPaymentsMissingCustodyOut:0,
        payrollPaymentMismatches:0,
        advanceDeductionMismatches:0,
        paidPayrollMissingAdvanceRepayments:0,
        expensesMissingCustodyLink:0
      },"linked payroll records should pass the read-only reconciliation checks");

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
      const linkedAdjustments = await apiPool.query(
        `SELECT l.id,l.line_type,l.amount,e.credit_amount,e.debit_amount
           FROM payroll_adjustment_lines l
           LEFT JOIN employee_earnings_ledger e ON e.payroll_adjustment_line_id=l.id
          WHERE l.payroll_item_id IN ($1,$2)`,
        [itemA.rows[0].id,itemB.rows[0].id]
      );
      assert.equal(linkedAdjustments.rowCount,4);
      assert.ok(linkedAdjustments.rows.every((row:{line_type:string;credit_amount:string|null;debit_amount:string|null}) =>
        row.line_type==="BONUS" ? Number(row.credit_amount)===100 && Number(row.debit_amount??0)===0
                                : Number(row.debit_amount)===100 && Number(row.credit_amount??0)===0),
        "every approved named bonus/deduction must create one matching employee-ledger entry");
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

      // Fixed monthly and salary-percentage installments reduce net pay in the approved
      // payroll, but the advance balance is not reduced until the employee is actually paid.
      const fixedAdvance = await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,installment_amount,repayment_status)
         VALUES($1,800,'Fixed installment integration test','PAID',$2,$2,'2099-01-15T12:00:00Z','FIXED_INSTALLMENT',300,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      const salaryPercentageAdvance = await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,salary_percentage,repayment_status)
         VALUES($1,500,'Salary percentage integration test','PAID',$2,$2,'2099-01-15T12:00:00Z','SALARY_PERCENTAGE',10,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      await apiPool.query(
        `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes)
         VALUES($1,'ADJUSTMENT',800,$2,'صرف سلفة ثابتة للاختبار'),($1,'ADJUSTMENT',500,$2,'صرف سلفة نسبة راتب للاختبار')`,
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
      assert.equal(Number(februaryItem.advance_repayment_amount), 400);
      assert.equal(Number(februaryItem.net_amount), 600, "fixed and salary-percentage installments reduce take-home pay without exceeding salary");
      const februaryAttendanceSnapshot = Array.from({length:28},(_,index)=>{
        const date = `2099-02-${String(index+1).padStart(2,"0")}`;
        return [
          {date,employeeId:employeeA.rows[0].id,status:"PRESENT",firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,needsReview:false},
          {date,employeeId:employeeB.rows[0].id,status:"PRESENT",firstIn:null,lastOut:null,workedMinutes:0,lateMinutes:0,earlyMinutes:0,needsReview:false}
        ];
      }).flat();
      const februaryApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${februaryData.json().data.period.id}/approve`,
        headers: { cookie: cookieHeader },
        payload: {attendanceSnapshot:februaryAttendanceSnapshot}
      });
      assert.equal(februaryApproval.statusCode, 200, februaryApproval.body);
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[fixedAdvance.rows[0].id])).rows[0].count,0,
        "approving payroll must not repay an advance before the salary is paid");
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[salaryPercentageAdvance.rows[0].id])).rows[0].count,0);

      const februaryPayment=await app.inject({
        method:"POST",url:`/api/payroll/items/${februaryItem.id}/payments`,
        headers:{cookie:cookieHeader},payload:{idempotencyKey:randomUUID(),amount:600,paymentMethod:"TEST"}
      });
      assert.equal(februaryPayment.statusCode,201,februaryPayment.body);
      assert.equal(februaryPayment.json().data.status,"PAID");
      const salaryAccrual=await apiPool.query("SELECT credit_amount FROM employee_earnings_ledger WHERE payroll_item_id=$1",[februaryItem.id]);
      assert.equal(salaryAccrual.rowCount,1,"approved gross salary must be visible in the employee account before payout");
      assert.equal(Number(salaryAccrual.rows[0].credit_amount),1000,"the base salary must be credited independently");
      const januaryBonusLineId = adjustmentLines.rows[0].id;
      const januaryDeductionLineId = adjustmentLines.rows[1].id;
      const bonusEntry=await apiPool.query(
        "SELECT credit_amount FROM employee_earnings_ledger WHERE employee_id=$1 AND payroll_adjustment_line_id=$2",
        [employeeA.rows[0].id,januaryBonusLineId]
      );
      assert.equal(bonusEntry.rowCount,1,"January bonus must appear as a separate source-linked employee-account credit");
      assert.equal(Number(bonusEntry.rows[0].credit_amount),100);
      const deductionEntry=await apiPool.query(
        "SELECT debit_amount FROM employee_earnings_ledger WHERE employee_id=$1 AND payroll_adjustment_line_id=$2",
        [employeeA.rows[0].id,januaryDeductionLineId]
      );
      assert.equal(deductionEntry.rowCount,1,"January deduction must appear as a separate source-linked employee-account debit");
      assert.equal(Number(deductionEntry.rows[0].debit_amount),100);
      const ownPayroll=await app.inject({method:"GET",url:"/api/payroll/my-account",headers:{cookie:cookieHeader}});
      assert.equal(ownPayroll.statusCode,200,ownPayroll.body);
      assert.equal(ownPayroll.json().data.employee.id,employeeA.rows[0].id);
      assert.ok(ownPayroll.json().data.payrollItems.every((x:any)=>x.employee_id===employeeA.rows[0].id),
        "employee salary history must never include another employee");
      const ownFebruary=ownPayroll.json().data.payrollItems.find((x:any)=>String(x.period_month).slice(0,7)==="2099-02");
      assert.ok(ownFebruary,"employees should see their approved monthly payslip");
      assert.equal(Number(ownFebruary.net_amount),600);
      assert.equal(Number(ownFebruary.bonus_amount),0);
      assert.equal(Number(ownFebruary.deduction_amount),0);
      assert.equal(Number(ownFebruary.advance_repayment_amount),400);
      assert.equal(ownFebruary.payments.length,1,"employee should see actual salary payment history");
      const ownJanuary=ownPayroll.json().data.payrollItems.find((x:any)=>String(x.period_month).slice(0,7)==="2099-01");
      assert.ok(ownJanuary,"employee should see the previous approved payslip too");
      assert.equal(Number(ownJanuary.bonus_amount),100);
      assert.equal(Number(ownJanuary.deduction_amount),100);
      const salaryPaymentLedger=await apiPool.query("SELECT debit_amount FROM employee_earnings_ledger WHERE payroll_payment_id=$1",[februaryPayment.json().data.payment.id]);
      assert.equal(salaryPaymentLedger.rowCount,1,"the actual salary payment must have a linked employee-ledger entry");
      assert.equal(Number(salaryPaymentLedger.rows[0].debit_amount),1000,"the gross salary entitlement must be cleared even when only 600 cash is paid");
      const fixedRepayment = await apiPool.query(
        "SELECT amount,repayment_type,source_payroll_item_id FROM advance_repayments WHERE advance_id=$1",
        [fixedAdvance.rows[0].id]
      );
      assert.equal(fixedRepayment.rowCount,1);
      assert.equal(Number(fixedRepayment.rows[0].amount),300);
      assert.equal(fixedRepayment.rows[0].repayment_type,"FIXED_INSTALLMENT");
      assert.equal(fixedRepayment.rows[0].source_payroll_item_id,februaryItem.id);
      const fixedBalance = await apiPool.query(
        "SELECT repayment_status,amount-(SELECT COALESCE(SUM(ar.amount),0) FROM advance_repayments ar WHERE ar.advance_id=advance_requests.id) AS remaining FROM advance_requests WHERE id=$1",
        [fixedAdvance.rows[0].id]
      );
      assert.equal(fixedBalance.rows[0].repayment_status,"OPEN");
      assert.equal(Number(fixedBalance.rows[0].remaining),500);
      const salaryPercentageRepayment = await apiPool.query(
        "SELECT amount,repayment_type,source_payroll_item_id FROM advance_repayments WHERE advance_id=$1",
        [salaryPercentageAdvance.rows[0].id]
      );
      assert.equal(salaryPercentageRepayment.rowCount,1);
      assert.equal(Number(salaryPercentageRepayment.rows[0].amount),100);
      assert.equal(salaryPercentageRepayment.rows[0].repayment_type,"SALARY_PERCENTAGE");
      assert.equal(salaryPercentageRepayment.rows[0].source_payroll_item_id,februaryItem.id);
      const repaymentLedger=await apiPool.query(
        `SELECT credit_amount,advance_repayment_id FROM employee_earnings_ledger
          WHERE employee_id=$1 AND advance_repayment_id IN (SELECT id FROM advance_repayments WHERE source_payroll_item_id=$2)`,
        [employeeA.rows[0].id,februaryItem.id]
      );
      assert.equal(repaymentLedger.rowCount,2,"each salary advance repayment must update the employee account");
      assert.equal(repaymentLedger.rows.reduce((sum:number,row:any)=>sum+Number(row.credit_amount),0),400);
      const reconciledAccount=await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeA.rows[0].id]
      );
      assert.equal(Number(reconciledAccount.rows[0].balance),100,"unpaid January wages remain a positive employee balance until they are paid");
      const custodySummary=await apiPool.query(
        "SELECT direction,SUM(amount) AS amount FROM cash_custody_transactions WHERE source_type IN ('PAYROLL_PAYMENT','PAYROLL_ADVANCE_REPAYMENT_OFFSET') AND source_id=$1 GROUP BY direction",
        [februaryPayment.json().data.payment.id]
      );
      assert.equal(custodySummary.rowCount,0,"non-cash payroll payments must not create cash-custody movements");
      const duplicateFebruaryApproval = await app.inject({
        method: "POST", url: `/api/payroll/periods/${februaryData.json().data.period.id}/approve`,
        headers: { cookie: cookieHeader }
      });
      assert.equal(duplicateFebruaryApproval.statusCode,409);
      assert.equal(duplicateFebruaryApproval.json().error.code,"PAYROLL_PERIOD_LOCKED");
      assert.equal((await apiPool.query("SELECT COUNT(*)::int AS count FROM advance_repayments WHERE advance_id=$1",[fixedAdvance.rows[0].id])).rows[0].count,1);

      const partialKey=randomUUID();
      const partialPayload={idempotencyKey:partialKey,amount:600,paymentMethod:"TEST"};
      const partial = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: partialPayload
      });
      assert.equal(partial.statusCode, 201, partial.body);
      assert.equal(partial.json().data.status, "PARTIAL");
      assert.equal(Number(partial.json().data.remainingAmount), 400);
      const partialRetry=await app.inject({
        method:"POST",url:`/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers:{cookie:cookieHeader},payload:partialPayload
      });
      assert.equal(partialRetry.statusCode,200,partialRetry.body,"retrying the same partial payout must return the original payment");
      assert.equal(partialRetry.json().data.payment.id,partial.json().data.payment.id);
      assert.equal(Number((await apiPool.query("SELECT COUNT(*)::int AS count FROM payroll_payments WHERE idempotency_key=$1",[partialKey])).rows[0].count),1);
      const reusedKey=await app.inject({
        method:"POST",url:`/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers:{cookie:cookieHeader},payload:{...partialPayload,amount:601}
      });
      assert.equal(reusedKey.statusCode,409,reusedKey.body);
      assert.equal(reusedKey.json().error.code,"IDEMPOTENCY_KEY_REUSED");

      const full = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount: 400, paymentMethod: "TEST" }
      });
      assert.equal(full.statusCode, 201, full.body);
      assert.equal(full.json().data.status, "PAID");
      assert.equal(Number(full.json().data.remainingAmount), 0);
      const finalEmployeeAccount=await apiPool.query(
        "SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",
        [employeeA.rows[0].id]
      );
      assert.equal(Number(finalEmployeeAccount.rows[0].balance),-900,"after all earned wages are paid, the employee account must equal the 900 remaining advance debt");

      const overpay = await app.inject({
        method: "POST", url: `/api/payroll/items/${itemA.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount: 0.01, paymentMethod: "TEST" }
      });
      assert.equal(overpay.statusCode, 409, overpay.body);
      assert.equal(overpay.json().error.code, "PAYROLL_OVERPAYMENT");

      const concurrent = await Promise.all([700, 700].map(amount => app.inject({
        method: "POST", url: `/api/payroll/items/${itemB.rows[0].id}/payments`,
        headers: { cookie: cookieHeader }, payload: { idempotencyKey: randomUUID(), amount, paymentMethod: "TEST" }
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

      // The read-only financial integrity overview must detect deliberately corrupted links.
      const diagnosticAdvance = await apiPool.query(
        `INSERT INTO advance_requests(employee_id,amount,reason,status,requested_by,paid_by,paid_at,repayment_method,installment_amount,repayment_status)
         VALUES($1,100,'Integrity diagnostic advance','PAID',$2,$2,'2099-01-15T12:00:00Z','FIXED_INSTALLMENT',10,'OPEN')
         RETURNING id`,
        [employeeA.rows[0].id,userId]
      );
      await apiPool.query(
        "INSERT INTO payroll_advance_deductions(payroll_item_id,advance_id,amount,repayment_type) VALUES($1,$2,10,'FIXED_INSTALLMENT')",
        [februaryItem.id,diagnosticAdvance.rows[0].id]
      );
      await apiPool.query("UPDATE payroll_items SET advance_repayment_amount=411 WHERE id=$1",[februaryItem.id]);
      await apiPool.query("UPDATE payroll_items SET status='PAID' WHERE id=$1",[itemB.rows[0].id]);
      const diagnosticExpense = await apiPool.query(
        `INSERT INTO accounting_expenses(category,description,amount,expense_date,created_by,expense_type,paid_from_employee_id)
         VALUES('OTHER','Integrity diagnostic expense',50,'2099-02-15',$1,'DIRECT',$2) RETURNING id`,
        [userId,employeeA.rows[0].id]
      );
      const diagnosticCustody = await apiPool.query(
        `INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id)
         VALUES($1,'OUT',40,'2099-02-15','Mismatched diagnostic custody movement',$2,'ACCOUNTING_EXPENSE',$3)
         RETURNING id`,
        [employeeB.rows[0].id,userId,diagnosticExpense.rows[0].id]
      );
      await apiPool.query(
        "UPDATE accounting_expenses SET cash_custody_transaction_id=$1 WHERE id=$2",
        [diagnosticCustody.rows[0].id,diagnosticExpense.rows[0].id]
      );

      // Deliberately corrupt a source-linked adjustment posting: wrong employee and amount.
      await apiPool.query(
        "UPDATE employee_earnings_ledger SET employee_id=$1,credit_amount=99 WHERE payroll_adjustment_line_id=$2",
        [employeeB.rows[0].id,januaryBonusLineId]
      );

      // A cash payment must be reconciled against the exact custody OUT amount.
      const itemBPayment = await apiPool.query(
        "SELECT id FROM payroll_payments WHERE payroll_item_id=$1 ORDER BY created_at DESC LIMIT 1",
        [itemB.rows[0].id]
      );
      assert.equal(itemBPayment.rowCount,1,"diagnostic cash payment must exist");
      await apiPool.query("UPDATE payroll_payments SET payment_method='CASH' WHERE id=$1",[itemBPayment.rows[0].id]);
      const expectedPayrollCustody = await apiPool.query(
        `SELECT pp.amount + COALESCE((
           SELECT SUM(ci.amount) FROM cash_custody_transactions ci
            WHERE ci.source_type='PAYROLL_ADVANCE_REPAYMENT_OFFSET'
              AND ci.source_id=pp.id AND ci.direction='IN'
         ),0) AS expected_amount,
         COALESCE((
           SELECT MIN(ci.employee_id) FROM cash_custody_transactions ci
            WHERE ci.source_type='PAYROLL_ADVANCE_REPAYMENT_OFFSET'
              AND ci.source_id=pp.id AND ci.direction='IN'
         ),$2::uuid) AS holder_id
         FROM payroll_payments pp WHERE pp.id=$1`,
        [itemBPayment.rows[0].id,employeeA.rows[0].id]
      );
      await apiPool.query(
        `INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by,source_type,source_id)
         VALUES($1,'OUT',$2,'2099-02-15','Duplicate payroll cash movement A',$3,'PAYROLL_PAYMENT',$4),
               ($1,'OUT',$2,'2099-02-15','Duplicate payroll cash movement B',$3,'PAYROLL_PAYMENT',$4)`,
        [expectedPayrollCustody.rows[0].holder_id,expectedPayrollCustody.rows[0].expected_amount,userId,itemBPayment.rows[0].id]
      );

      const integrityFindings = await app.inject({
        method:"GET",url:"/api/accounting/reconciliation/overview",headers:{cookie:cookieHeader}
      });
      assert.equal(integrityFindings.statusCode,200,integrityFindings.body);
      const findingData=integrityFindings.json().data;
      assert.ok(findingData.counts.payrollPaymentMismatches>=1,
        "integrity overview must detect a PAID payroll item whose recorded payments do not match net pay");
      assert.ok(findingData.counts.advanceDeductionMismatches>=1,
        "integrity overview must detect a mismatch between payroll advance deduction total and its detail rows");
      assert.ok(findingData.counts.paidPayrollMissingAdvanceRepayments>=1,
        "integrity overview must detect a paid payroll deduction without its advance repayment ledger row");
      assert.ok(findingData.counts.expensesMissingCustodyLink>=1,
        "integrity overview must detect an explicitly linked custody movement with a different employee and amount");
      assert.ok(findingData.counts.missingAdjustmentLedgerEntries>=1,
        "integrity overview must detect a source-linked adjustment with the wrong employee and amount");
      assert.ok(findingData.counts.cashPaymentsMissingCustodyOut>=1,
        "integrity overview must detect duplicate cash payroll custody OUT movements");
      assert.ok(findingData.issues.cashPaymentsMissingCustodyOut.some((row: {payment_id:string;custody_out_count:number}) =>
        row.payment_id===itemBPayment.rows[0].id && row.custody_out_count>=2),
        "integrity overview must report the number of duplicate custody OUT movements for the payroll payment");

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
