import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertDisposableDatabaseUrl } from "./helpers/disposable-database-url.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("employee self-service is scoped to the signed-in employee and hides voided slip lines", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_self_service_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
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
    process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
    process.env.NODE_ENV = "test";
    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { selfServiceRoutes }, { attendanceRoutes }, { hashPassword }, poolModule] = await Promise.all([
      import("fastify"), import("@fastify/cookie"),
      import("../src/modules/auth/auth.routes.js"),
      import("../src/modules/self-service/self-service.routes.js"),
      import("../src/modules/attendance/attendance.routes.js"),
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
    await app.register(attendanceRoutes);
    await app.register(selfServiceRoutes);
    try {
      const password = "Test-Only-Password-2026!";
      const mk = async (label: string, role: string) => {
        const emp = await apiPool!.query("INSERT INTO employees(full_name) VALUES($1) RETURNING id", [label]);
        const username = "ss-" + randomBytes(5).toString("hex");
        const user = await apiPool!.query(
          "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
          [username, hashPassword(password), emp.rows[0].id]);
        await apiPool!.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2", [user.rows[0].id, role]);
        const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
        assert.equal(login.statusCode, 200, login.body);
        const sc = login.headers["set-cookie"];
        return { employeeId: emp.rows[0].id as string, userId: user.rows[0].id as string, cookie: (Array.isArray(sc) ? sc[0] : sc)!.split(";")[0]! };
      };
      const alice = await mk("Self Service Alice", "employee");
      const bob = await mk("Self Service Bob", "employee");

      // The employee role exists and carries own-scope permissions only.
      const rolePerms = await apiPool.query(
        "SELECT p.code FROM roles r JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE r.code='employee' ORDER BY p.code");
      const codes = rolePerms.rows.map(r => r.code as string).sort();
      assert.deepEqual(codes, ["attendance.permission.request", "attendance.permission.view_own", "attendance.view_own", "cash_custody.create_own", "cash_custody.transfer_own", "cash_custody.view_own", "payroll.view_own"].sort());

      // Staff cannot use manager attendance endpoints.
      const manager = await app.inject({ method: "GET", url: "/api/attendance/report?from=2026-11-01&to=2026-11-02", headers: { cookie: alice.cookie } });
      assert.equal(manager.statusCode, 403);

      // Schedule + punches for both employees on the same day.
      for (const e of [alice, bob]) {
        for (let weekday = 0; weekday < 7; weekday++) await apiPool.query(
          "INSERT INTO attendance_weekly_schedule_versions(employee_id,weekday,starts_at,ends_at,is_day_off,effective_from,created_by) VALUES($1,$2,'08:00','16:00',FALSE,'2026-01-01',$3)",
          [e.employeeId, weekday, e.userId]);
      }
      const punch = (e: typeof alice, at: string, status: string, key: string) => apiPool!.query(
        "INSERT INTO attendance_punches(employee_id,device_code,punch_at,status,external_key) VALUES($1,'1',$2,$3,$4)", [e.employeeId, at, status, key + randomBytes(4).toString("hex")]);
      await punch(alice, "2026-11-04T06:00:00Z", "IN", "a-in");
      await punch(alice, "2026-11-04T14:00:00Z", "OUT", "a-out");
      await punch(bob, "2026-11-04T06:30:00Z", "IN", "b-in");
      await punch(bob, "2026-11-04T14:00:00Z", "OUT", "b-out");

      const mine = await app.inject({ method: "GET", url: "/api/me/attendance?from=2026-11-04&to=2026-11-04", headers: { cookie: alice.cookie } });
      assert.equal(mine.statusCode, 200, mine.body);
      const body = mine.json().data;
      assert.equal(body.days.length, 1, "only the signed-in employee's days are returned");
      assert.equal(body.days[0].status, "PRESENT");
      assert.equal(body.punches.length, 2, "only own punches are returned");
      assert.equal(body.days[0].employeeId, undefined, "no staff identifiers in the self-service shape");
      const schedule = await app.inject({ method: "GET", url: "/api/me/schedule", headers: { cookie: alice.cookie } });
      assert.equal(schedule.statusCode, 200, schedule.body);
      assert.equal(schedule.json().data.weekly.length, 7);
      // A forged employee id is ignored: the session decides.
      const forged = await app.inject({ method: "GET", url: `/api/me/attendance?from=2026-11-04&to=2026-11-04&employeeId=${bob.employeeId}`, headers: { cookie: alice.cookie } });
      assert.equal(forged.json().data.punches.length, 2);
      assert.equal(forged.json().data.days[0].firstIn, body.days[0].firstIn);
      const bad = await app.inject({ method: "GET", url: "/api/me/attendance?from=2026-01-01&to=2026-12-31", headers: { cookie: alice.cookie } });
      assert.equal(bad.statusCode, 422);

      // Payslips: approved only, own only, voided lines hidden.
      const period = await apiPool.query("INSERT INTO payroll_periods(period_month,status,generated_by,approved_by,approved_at) VALUES('2026-10-01','APPROVED',$1,$1,now()) RETURNING id", [alice.userId]);
      const draft = await apiPool.query("INSERT INTO payroll_periods(period_month,status,generated_by) VALUES('2026-11-01','DRAFT',$1) RETURNING id", [alice.userId]);
      const item = async (periodId: string, e: typeof alice, base: number) => (await apiPool!.query(
        "INSERT INTO payroll_items(period_id,employee_id,base_salary) VALUES($1,$2,$3) RETURNING id", [periodId, e.employeeId, base])).rows[0].id as string;
      const aliceItem = await item(period.rows[0].id, alice, 5000);
      await item(period.rows[0].id, bob, 7000);
      await item(draft.rows[0].id, alice, 5000);
      await apiPool.query("INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,created_by) VALUES($1,'BONUS','حافز حضور',100,$2)", [aliceItem, alice.userId]);
      await apiPool.query(
        "INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,created_by,status,void_reason,voided_by,voided_at) VALUES($1,'DEDUCTION','خصم ملغي',50,$2,'VOIDED','تم الإلغاء',$2,now())", [aliceItem, alice.userId]);
      const slips = await app.inject({ method: "GET", url: "/api/me/payslips", headers: { cookie: alice.cookie } });
      assert.equal(slips.statusCode, 200, slips.body);
      const data = slips.json().data;
      assert.equal(data.length, 1, "draft periods and other employees' slips are not visible");
      assert.equal(data[0].id, aliceItem);
      assert.equal(data[0].employee_name, "Self Service Alice");
      assert.deepEqual(data[0].lines.map((l: { description: string }) => l.description), ["حافز حضور"], "voided lines never appear");

      // No session: rejected.
      assert.equal((await app.inject({ method: "GET", url: "/api/me/payslips" })).statusCode, 401);
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
