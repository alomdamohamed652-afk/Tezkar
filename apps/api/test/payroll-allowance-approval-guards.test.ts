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

// Months are derived from "now" so the guards keep exercising the same rules
// whenever CI runs: P1 = last month (fully approvable), P3 = two months ago
// (unpaid-leave case), P2 = the current month (early finalization must block).
const pad = (n: number) => String(n).padStart(2, "0");
function shiftMonth(delta: number) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}
const daysOfMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
const fridaysOf = (y: number, m: number) => {
  const out: number[] = [];
  for (let d = 1; d <= daysOfMonth(y, m); d++) if (new Date(y, m, d).getDay() === 5) out.push(d);
  return out;
};
const monthStart = (y: number, m: number) => `${y}-${pad(m + 1)}-01`;
const monthEnd = (y: number, m: number) => `${y}-${pad(m + 1)}-${pad(daysOfMonth(y, m))}`;
const dayDate = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

test("payroll approval enforces allowance-pool, unpaid-leave, partial-period and early-finalization guards end to end", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl, "TEST_DATABASE_URL must point to a disposable PostgreSQL test server");
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_allowance_guards_" + randomBytes(6).toString("hex");
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

    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { payrollRoutes }, { attendanceRoutes }, { hashPassword }, poolModule, calcModule, reportModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/payroll/payroll.routes.js"),
        import("../src/modules/attendance/attendance.routes.js"),
        import("../src/modules/auth/auth.service.js"),
        import("../src/db/pool.js"),
        import("../src/modules/payroll/payroll-attendance-calculation.js"),
        import("../src/modules/attendance/attendance-report.service.js")
      ]);
    apiPool = poolModule.pool;
    const pool = apiPool;

    const app = Fastify();
    await app.register(cookie, { secret: process.env.SESSION_SECRET });
    app.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await app.register(authRoutes);
    await app.register(payrollRoutes);
    await app.register(attendanceRoutes);

    const password = "Test-Only-Password-2026!";
    const newEmployee = async (fullName: string) =>
      (await pool.query("INSERT INTO employees(full_name) VALUES ($1) RETURNING id", [fullName])).rows[0].id as string;
    const managerEmployeeId = await newEmployee("Allowance Guards Manager");
    const fullId = await newEmployee("Allowance Guards Full Month");
    const partialOkId = await newEmployee("Allowance Guards Partial No Payout");
    const partialPayoutId = await newEmployee("Allowance Guards Partial With Payout");
    const managerUserId = (await pool.query(
      "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES ($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
      ["allowance-guards-" + randomBytes(5).toString("hex"), hashPassword(password), managerEmployeeId]
    )).rows[0].id as string;
    await pool.query(
      "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='manager' ON CONFLICT DO NOTHING",
      [managerUserId]
    );
    await pool.query(
      "INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' ON CONFLICT DO NOTHING",
      []
    );

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: (await pool.query("SELECT username FROM users WHERE id=$1", [managerUserId])).rows[0].username, password }
    });
    assert.equal(login.statusCode, 200, login.body);
    const setCookie = login.headers["set-cookie"];
    assert.ok(setCookie, "login must issue a session cookie");
    const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];

    // Weekly schedule: work 08:00-16:00 every day except Friday (weekday 5).
    for (const employeeId of [fullId, partialOkId, partialPayoutId]) {
      for (let weekday = 0; weekday < 7; weekday++) {
        await pool.query(
          "INSERT INTO attendance_weekly_schedule_versions(employee_id,weekday,starts_at,ends_at,is_day_off,effective_from,created_by) VALUES($1,$2,'08:00','16:00',$3,'2020-01-01',$4)",
          [employeeId, weekday, weekday === 5, managerUserId]
        );
      }
      // Shared monthly rest/paid-leave pool of 2 days; rest-day rate 100.
      await pool.query(
        "INSERT INTO employee_payroll_attendance_policies(employee_id,work_days_per_month,daily_work_minutes,day_off_pay_amount,overtime_multiplier,allowed_leave_days_per_month,updated_by) VALUES($1,26,480,100,1.5,2,$2)",
        [employeeId, managerUserId]
      );
    }

    const p1 = shiftMonth(-1);
    const p3 = shiftMonth(-2);
    const p2 = shiftMonth(0);
    const p1Fridays = fridaysOf(p1.y, p1.m);
    assert.ok(p1Fridays.length >= 4, "test assumes at least 4 rest days in the previous month");

    // Salary profiles: full-month employee long ago; partial employees mid-P1.
    await pool.query(
      "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,3000,'2020-01-01',$2)",
      [fullId, managerUserId]
    );
    await pool.query(
      "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,3000,$2,$3)",
      [partialOkId, dayDate(p1.y, p1.m, 15), managerUserId]
    );
    await pool.query(
      "INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,created_by) VALUES ($1,3000,$2,$3)",
      [partialPayoutId, dayDate(p1.y, p1.m, 20), managerUserId]
    );

    const newPeriod = async (month: string) =>
      (await pool.query("INSERT INTO payroll_periods(period_month,generated_by) VALUES ($1,$2) RETURNING id", [month, managerUserId])).rows[0].id as string;
    const newItem = async (periodId: string, employeeId: string, base: number) =>
      (await pool.query(
        "INSERT INTO payroll_items(period_id,employee_id,base_salary,bonus_amount,deduction_amount) VALUES ($1,$2,$3,0,0) RETURNING id",
        [periodId, employeeId, base]
      )).rows[0].id as string;

    const p1Id = await newPeriod(monthStart(p1.y, p1.m));
    const fullP1Item = await newItem(p1Id, fullId, 3000);
    const partialOkItem = await newItem(p1Id, partialOkId, 1500);
    const partialPayoutItem = await newItem(p1Id, partialPayoutId, 1200);
    const p2Id = await newPeriod(monthStart(p2.y, p2.m));
    await newItem(p2Id, fullId, 3000);
    const p3Id = await newPeriod(monthStart(p3.y, p3.m));
    const fullP3Item = await newItem(p3Id, fullId, 3000);

    const approve = (periodId: string) =>
      app.inject({ method: "POST", url: `/api/payroll/periods/${periodId}/approve`, headers: { cookie: cookieHeader }, payload: {} });

    // Scenario A: unsettled workdays block approval in pool mode.
    let response = await approve(p1Id);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error?.code, "ATTENDANCE_ABSENCE_UNCONFIRMED", response.body);

    const settleDay = async (employeeId: string, date: string, status: string, workedMinutes: number) =>
      pool.query(
        "INSERT INTO attendance_day_overrides(employee_id,attendance_date,status,worked_minutes,note,created_by,updated_by) VALUES($1,$2::date,$3,$4,'allowance-guards-test',$5,$5)",
        [employeeId, date, status, workedMinutes, managerUserId]
      );

    // Settle P1 inside each employee's salary-profile window: every workday PRESENT.
    const profileStartDay = new Map<string, number>([[fullId, 1], [partialOkId, 15], [partialPayoutId, 20]]);
    for (let d = 1; d <= daysOfMonth(p1.y, p1.m); d++) {
      if (p1Fridays.includes(d)) continue;
      for (const employeeId of [fullId, partialOkId, partialPayoutId]) {
        if (d >= profileStartDay.get(employeeId)!) await settleDay(employeeId, dayDate(p1.y, p1.m, d), "PRESENT", 480);
      }
    }
    // Full-month employee works all rest days except the first -> pool usage 1 -> payout 1 day.
    for (const d of p1Fridays.slice(1)) await settleDay(fullId, dayDate(p1.y, p1.m, d), "PRESENT", 480);
    // Partial-payout employee works every rest day inside his window -> pool 0 -> payout pending.
    for (const d of p1Fridays.filter((d) => d >= 20)) await settleDay(partialPayoutId, dayDate(p1.y, p1.m, d), "PRESENT", 480);

    // Scenario E: a partial salary period with a pending payout must not approve.
    response = await approve(p1Id);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error?.code, "LEAVE_PAYOUT_PERIOD_UNRESOLVED", response.body);

    // Scenario B: without the blocked employee, the settled month approves.
    await pool.query("DELETE FROM payroll_items WHERE id=$1", [partialPayoutItem]);
    response = await approve(p1Id);
    assert.equal(response.statusCode, 200, response.body);

    // Cross-check the persisted payroll math against the calculator on the same derived days.
    const toCalcDays = (rows: any[]) => rows.map((day: any) => ({
      ...day,
      date: String(day.date),
      workedMinutes: Number(day.workedMinutes ?? 0),
      lateMinutes: 0,
      earlyMinutes: 0,
      overtimeMinutes: 0,
      paidPermissionMinutes: 0,
      unpaidPermissionMinutes: 0,
      isDayOff: Boolean(day.isDayOff),
      needsReview: Boolean(day.needsReview)
    }));
    const policy = { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 100, overtimeMultiplier: 1.5, allowedLeaveDaysPerMonth: 2 };

    const reportP1 = await reportModule.buildAttendanceReport(pool, monthStart(p1.y, p1.m), monthEnd(p1.y, p1.m), true);
    const calcFull = calcModule.calculatePayrollAttendance({
      baseSalary: 3000,
      existingBonus: 0,
      policy,
      days: toCalcDays(reportP1.data.filter((day: any) => String(day.employeeId) === String(fullId)))
    });
    assert.equal(calcFull.restDaysUsed, 1, "one unworked rest day consumes one pool day");
    assert.equal(calcFull.leavePayoutDays, 1, "the remaining pool day is paid out");
    assert.equal(calcFull.leavePayoutAmount, 100, "payout uses the configured rest-day rate");
    assert.equal(calcFull.dayOffBonus, 0, "worked rest days earn no day-off bonus in pool mode (never double-paid)");
    const payoutLine = await pool.query(
      "SELECT amount FROM payroll_adjustment_lines WHERE payroll_item_id=$1 AND source_key='attendance:leave-payout'",
      [fullP1Item]
    );
    assert.equal(payoutLine.rowCount, 1, "approval persists exactly one leave-payout line");
    assert.equal(Number(payoutLine.rows[0].amount), calcFull.leavePayoutAmount, "persisted payout matches the calculator");
    const snapshotCount = await pool.query(
      "SELECT count(*)::int AS c FROM payroll_attendance_snapshots WHERE payroll_item_id=$1",
      [fullP1Item]
    );
    assert.equal(snapshotCount.rows[0].c, daysOfMonth(p1.y, p1.m), "one daily snapshot per calendar day");
    const partialPayoutLines = await pool.query(
      "SELECT count(*)::int AS c FROM payroll_adjustment_lines WHERE payroll_item_id=$1 AND source_key='attendance:leave-payout'",
      [partialOkItem]
    );
    assert.equal(partialPayoutLines.rows[0].c, 0, "partial period inside the pool pays nothing out");

    // Scenario C: one UNPAID_LEAVE workday deducts a full day without consuming the pool.
    const p3Fridays = fridaysOf(p3.y, p3.m);
    let unpaidDay = 0;
    for (let d = 1; d <= daysOfMonth(p3.y, p3.m); d++) {
      if (p3Fridays.includes(d)) continue;
      if (unpaidDay === 0) unpaidDay = d;
      await settleDay(fullId, dayDate(p3.y, p3.m, d), d === unpaidDay ? "UNPAID_LEAVE" : "PRESENT", d === unpaidDay ? 0 : 480);
    }
    response = await approve(p3Id);
    assert.equal(response.statusCode, 200, response.body);
    const reportP3 = await reportModule.buildAttendanceReport(pool, monthStart(p3.y, p3.m), monthEnd(p3.y, p3.m), true);
    const calcP3 = calcModule.calculatePayrollAttendance({
      baseSalary: 3000,
      existingBonus: 0,
      policy,
      days: toCalcDays(reportP3.data.filter((day: any) => String(day.employeeId) === String(fullId)))
    });
    assert.equal(calcP3.unpaidLeaveMinutes, 480, "unpaid leave deducts one full workday");
    assert.equal(calcP3.restDaysUsed, 2, "unworked rest days consume the pool but unpaid leave does not");
    assert.equal(calcP3.leavePayoutDays, 0, "pool fully consumed by rest days, nothing paid out");
    const deductionLine = await pool.query(
      "SELECT amount FROM payroll_adjustment_lines WHERE payroll_item_id=$1 AND source_key='attendance:deduction'",
      [fullP3Item]
    );
    assert.equal(deductionLine.rowCount, 1, "approval persists exactly one attendance deduction line");
    assert.equal(Number(deductionLine.rows[0].amount), calcP3.deductionAmount, "persisted deduction matches the calculator");

    // Scenario D: approving the still-open current month is blocked for allowance employees.
    response = await approve(p2Id);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error?.code, "LEAVE_PAYOUT_EARLY_FINALIZATION", response.body);
  } finally {
    try {
      if (apiPool) await apiPool.end();
    } finally {
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await cleanup.end();
    }
  }
});
