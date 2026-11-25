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
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()), "test DB must be local");
  assert.equal(url.pathname.slice(1), "postgres", "test DB admin connection must target postgres");
}

// Creator-based own-scope editing: a shift leader holding production.edit_own may
// edit/delete only production entries he submitted himself (even for other workers),
// while production.edit holders keep full scope and all record-state guards stay.
test("production edit/delete is creator-scoped for production.edit_own holders", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_edit_own_" + randomBytes(6).toString("hex");
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
  let app: { close: () => Promise<void> } | undefined;

  try {
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: "utf8"
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    process.env.DATABASE_URL = target.toString();
    process.env.WEB_ORIGIN = "http://localhost:3000";
    process.env.SESSION_SECRET = "test-only-edit-own-session-secret-long-enough";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { productionRoutes }, { hashPassword }, poolModule] =
      await Promise.all([
        import("fastify"),
        import("@fastify/cookie"),
        import("../src/modules/auth/auth.routes.js"),
        import("../src/modules/production/production.routes.js"),
        import("../src/modules/auth/auth.service.js"),
        import("../src/db/pool.js")
      ]);
    apiPool = poolModule.pool;

    const server = Fastify();
    app = server;
    await server.register(cookie, { secret: process.env.SESSION_SECRET });
    server.setErrorHandler((error, _request, reply) => {
      const status = typeof error.statusCode === "number" && error.statusCode < 500 ? error.statusCode : 500;
      reply.code(status).send({ error: { code: error.code ?? "ERROR", message: error.message } });
    });
    await server.register(authRoutes);
    await server.register(productionRoutes);

    const suffix = randomBytes(4).toString("hex");
    const leaderPassword = "Test-Edit-Own-Leader-2026!";
    const mkUser = async (username: string, role: string, withEmployee: boolean) => {
      let employeeId: string | null = null;
      if (withEmployee) {
        employeeId = (await apiPool!.query("INSERT INTO employees(full_name) VALUES($1) RETURNING id", ["Emp " + username])).rows[0].id;
      }
      const user = (await apiPool!.query(
        "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
        [username, hashPassword(leaderPassword), employeeId]
      )).rows[0];
      await apiPool!.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2", [user.id, role]);
      return user;
    };

    const leaderA = await mkUser("leadera-" + suffix, "shift_leader", true);
    const leaderB = await mkUser("leaderb-" + suffix, "shift_leader", true);
    const manager = await mkUser("manager-" + suffix, "manager", true);
    const plainWorker = await mkUser("worker-" + suffix, "worker", true);
    const otherEmployee = (await apiPool.query("INSERT INTO employees(full_name) VALUES('Other Worker Employee') RETURNING id")).rows[0];

    const login = async (userId: string) => {
      const username = (await apiPool!.query("SELECT username FROM users WHERE id=$1", [userId])).rows[0].username;
      const res = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: leaderPassword } });
      assert.equal(res.statusCode, 200, res.body);
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    };
    const leaderACookie = await login(leaderA.id);
    const leaderBCookie = await login(leaderB.id);
    const managerCookie = await login(manager.id);
    const workerCookie = await login(plainWorker.id);

    const unit = (await apiPool.query("SELECT id FROM units WHERE code='PCS' LIMIT 1")).rows[0];
    const rateGroup = (await apiPool.query("INSERT INTO rate_groups(name) VALUES('Edit own rate group') RETURNING id")).rows[0];
    const shift = (await apiPool.query(
      "INSERT INTO shifts(name,start_time,end_time,rate_group_id) VALUES('Edit own shift','08:00','16:00',$1) RETURNING id",
      [rateGroup.id]
    )).rows[0];
    const stage = (await apiPool.query("INSERT INTO stages(name) VALUES('Edit own stage') RETURNING id")).rows[0];
    const product = (await apiPool.query(
      "INSERT INTO products(name,product_type,unit_id) VALUES('Edit own product','FINISHED_GOOD',$1) RETURNING id",
      [unit.id]
    )).rows[0];
    const wageType = (await apiPool.query("SELECT id,code,method FROM wage_types WHERE method='PER_PIECE' LIMIT 1")).rows[0];
    await apiPool.query(
      `INSERT INTO rates(product_id,stage_id,rate_group_id,wage_type_id,unit_id,rate,effective_range,is_active,created_by)
       VALUES($1,$2,$3,$4,$5,10,daterange(CURRENT_DATE-1,CURRENT_DATE+30,'[)'),TRUE,$6)`,
      [product.id, stage.id, rateGroup.id, wageType.id, unit.id, manager.id]
    );
    const workDate = new Date().toISOString().slice(0, 10);

    const mkEntry = async (submittedBy: string, status: string) => (await apiPool!.query(
      `INSERT INTO production_entries(
         employee_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,rate_id,
         rate_snapshot,wage_type_id,wage_type_code_snapshot,wage_type_method_snapshot,
         earning_amount,status,submitted_by,approved_by,approved_at
       ) VALUES($1,$2,$3,$4,$5,10,$6,NULL,10,$7,$8,$9,100,$10,$11,$12,CASE WHEN $10='APPROVED' THEN now() ELSE NULL END)
       RETURNING id`,
      [otherEmployee.id, product.id, stage.id, shift.id, workDate, unit.id, wageType.id,
        wageType.code, wageType.method, status, submittedBy,
        status === 'APPROVED' ? manager.id : null]
    )).rows[0];

    // Own-submitted entry for another worker: editable by its creator.
    const ownEntry = await mkEntry(leaderA.id, "PENDING");
    // Entry submitted by a different shift leader.
    const otherEntry = await mkEntry(leaderB.id, "PENDING");
    // Approved entry submitted by leaderA: correction path stays locked.
    const ownApproved = await mkEntry(leaderA.id, "APPROVED");

    const patch = (cookie: string, id: string) => server.inject({
      method: "PATCH", url: "/api/production/" + id,
      headers: { cookie },
      payload: { bonusAmount: 5, bonusReason: "تعديل اختبار النطاق" }
    });
    const del = (cookie: string, id: string, password: string) => server.inject({
      method: "DELETE", url: "/api/production/" + id,
      headers: { cookie },
      payload: { password }
    });

    // 1) Creator edits his own entry (submitted for another worker): allowed.
    const ownPatch = await patch(leaderACookie, ownEntry.id);
    assert.equal(ownPatch.statusCode, 200, ownPatch.body);

    // 2) Creator deletes his own entry with password: allowed.
    const ownDelete = await del(leaderACookie, ownEntry.id, leaderPassword);
    assert.equal(ownDelete.statusCode, 200, ownDelete.body);

    // 3) Cross-creator edit denied.
    const crossPatch = await patch(leaderACookie, otherEntry.id);
    assert.equal(crossPatch.statusCode, 403, crossPatch.body);
    assert.match(crossPatch.body, /PRODUCTION_EDIT_OWN_ONLY/);

    // 4) Cross-creator delete denied even with the actor's correct password.
    const crossDelete = await del(leaderACookie, otherEntry.id, leaderPassword);
    assert.equal(crossDelete.statusCode, 403, crossDelete.body);
    assert.match(crossDelete.body, /PRODUCTION_EDIT_OWN_ONLY/);

    // 5) Full-scope holder (manager, production.edit) still edits any entry.
    const managerPatch = await patch(managerCookie, otherEntry.id);
    assert.equal(managerPatch.statusCode, 200, managerPatch.body);

    // 6) Record-state guard preserved: own APPROVED entry stays locked without edit_approved.
    const approvedPatch = await patch(leaderACookie, ownApproved.id);
    assert.equal(approvedPatch.statusCode, 403, approvedPatch.body);
    assert.match(approvedPatch.body, /PRODUCTION_EDIT_LOCKED/);

    // 7) No edit permission at all: blocked at the gate.
    const workerPatch = await patch(workerCookie, otherEntry.id);
    assert.equal(workerPatch.statusCode, 403, workerPatch.body);

    // 8) List exposes server-computed can_edit per row: own true, other false for edit_own holder.
    const list = await server.inject({
      method: "GET", url: "/api/production?status=PENDING&limit=50",
      headers: { cookie: leaderBCookie }
    });
    assert.equal(list.statusCode, 200, list.body);
    const rows = list.json().data as Array<{ id: string; can_edit: boolean }>;
    const otherRow = rows.find(r => r.id === otherEntry.id);
    const ownApprovedRow = rows.find(r => r.id === ownApproved.id);
    assert.ok(otherRow, "leader B should see the pending entry he submitted");
    assert.equal(otherRow!.can_edit, true);
    if (ownApprovedRow) assert.equal(ownApprovedRow.can_edit, true);
    const leaderAList = await server.inject({
      method: "GET", url: "/api/production?status=PENDING&limit=50",
      headers: { cookie: leaderACookie }
    });
    const aRows = leaderAList.json().data as Array<{ id: string; can_edit: boolean }>;
    const aViewOfOther = aRows.find(r => r.id === otherEntry.id);
    assert.ok(aViewOfOther);
    assert.equal(aViewOfOther!.can_edit, false);
  } finally {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    const admin2 = new pg.Client({ connectionString: adminUrl });
    await admin2.connect();
    try {
      await admin2.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await admin2.end();
    }
  }
});
