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
  assert.equal(url.pathname.slice(1), "postgres", "test DB admin connection must target disposable admin database postgres");
}

test("cash custody own-scope transfers and permission grouping normalization", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const name = "tezkar_transfer_own_" + randomBytes(6).toString("hex");
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
    process.env.SESSION_SECRET = "test-only-transfer-own-session-secret";
    process.env.NODE_ENV = "test";

    const [{ default: Fastify }, { default: cookie }, { authRoutes }, { custodyRoutes }, { hashPassword }, poolModule] = await Promise.all([
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
      // --- Catalog invariants after the grouping + own-transfer migrations.
      const catalog = await apiPool.query("SELECT count(*)::int AS n, count(DISTINCT code)::int AS d FROM permissions");
      assert.equal(catalog.rows[0].n, catalog.rows[0].d, "permission codes must stay unique");
      const modules = (await apiPool.query("SELECT DISTINCT module FROM permissions")).rows.map(r => r.module as string);
      const canonical = new Set(["attendance","iam","hr","employees","payroll","orders","production","machine_production","warehouse","finance","tasks","master_data","laser_designs","reverse_coding","system","reports","dashboard","earnings","auth","custody","cash_custody"]);
      assert.deepEqual(modules.filter(m => !canonical.has(m)), [], "every module must map to a named settings section");
      const employeeGrants = (await apiPool.query(
        "SELECT p.code FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.code='employee' AND p.code LIKE 'cash_custody.%' ORDER BY p.code"
      )).rows.map(r => r.code);
      assert.deepEqual(employeeGrants, ["cash_custody.create_own","cash_custody.transfer_own","cash_custody.view_own"]);

      // --- Fixtures.
      const mkEmployee = async (fullName: string) =>
        (await apiPool.query("INSERT INTO employees(full_name) VALUES ($1) RETURNING id", [fullName])).rows[0].id as string;
      const empA = await mkEmployee("Transfer Own Employee A");
      const empB = await mkEmployee("Transfer Own Employee B");
      const empC = await mkEmployee("Transfer Own Employee C NoCustody");
      const empD = await mkEmployee("Transfer Own Employee D ViewOnly");
      const empMgr = await mkEmployee("Transfer Own Manager");
      const mkUser = async (prefix: string, employeeId: string, role: string, password: string) => {
        const username = prefix + randomBytes(4).toString("hex");
        const u = (await apiPool.query(
          "INSERT INTO users(username,password_hash,employee_id,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,$3,TRUE,FALSE,FALSE) RETURNING id",
          [username, hashPassword(password), employeeId]
        )).rows[0];
        await apiPool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 ON CONFLICT DO NOTHING", [u.id, role]);
        return username;
      };
      const pwA = "Test-Transfer-A-2026!", pwMgr = "Test-Transfer-Mgr-2026!", pwD = "Test-Transfer-D-2026!";
      const userA = await mkUser("trfa-", empA, "employee", pwA);
      const mgrUser = await mkUser("trfmgr-", empMgr, "manager", pwMgr);
      const viewOnlyRole = (await apiPool.query("INSERT INTO roles(code,name,is_system) VALUES('transfer_view_only_test','عرض فقط اختبار',FALSE) RETURNING id")).rows[0];
      await apiPool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,p.id FROM permissions p WHERE p.code='cash_custody.view_own'", [viewOnlyRole.id]);
      const userD = await mkUser("trfd-", empD, "transfer_view_only_test", pwD);

      // Custody accounts: A holds 500, B holds 100, C has no account at all.
      await apiPool.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by) VALUES($1,'IN',500,CURRENT_DATE,'رصيد افتتاحي',NULL)", [empA]);
      await apiPool.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,created_by) VALUES($1,'IN',100,CURRENT_DATE,'رصيد افتتاحي',NULL)", [empB]);
      const balanceOf = async (employeeId: string) => Number((await apiPool.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS b FROM cash_custody_transactions WHERE employee_id=$1", [employeeId]
      )).rows[0].b);

      async function login(username: string, password: string) {
        const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
        assert.equal(response.statusCode, 200, response.body);
        const setCookie = response.headers["set-cookie"];
        assert.ok(setCookie);
        return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
      }
      const cookieA = await login(userA, pwA);
      const cookieMgr = await login(mgrUser, pwMgr);
      const cookieD = await login(userD, pwD);

      const transfer = (cookie: string, payload: Record<string, unknown>) =>
        app.inject({ method: "POST", url: "/api/cash-custody/transfers", headers: { cookie }, payload });

      // Own-scope: A -> B (B holds custody) succeeds and moves the balance.
      const ok = await transfer(cookieA, { fromEmployeeId: empA, toEmployeeId: empB, amount: 100, description: "تحويل إلى زميل" });
      assert.equal(ok.statusCode, 201, ok.body);
      assert.equal(await balanceOf(empA), 400);
      assert.equal(await balanceOf(empB), 200);

      // Own-scope: target without any custody account is rejected.
      const noCustody = await transfer(cookieA, { fromEmployeeId: empA, toEmployeeId: empC, amount: 10, description: "تحويل لغير صاحب عهدة" });
      assert.equal(noCustody.statusCode, 422, noCustody.body);
      assert.equal(noCustody.json().error.code, "TARGET_HAS_NO_CUSTODY");

      // Own-scope: source must be the caller's own custody.
      const foreignSource = await transfer(cookieA, { fromEmployeeId: empB, toEmployeeId: empA, amount: 10, description: "مصدر ليس عهدتي" });
      assert.equal(foreignSource.statusCode, 403, foreignSource.body);
      assert.equal(foreignSource.json().error.code, "OWN_SCOPE_ONLY");

      // Own-scope: cannot transfer to oneself.
      const selfTarget = await transfer(cookieA, { fromEmployeeId: empA, toEmployeeId: empA, amount: 10, description: "إلى نفسي" });
      assert.equal(selfTarget.statusCode, 422, selfTarget.body);
      assert.equal(selfTarget.json().error.code, "INVALID_TRANSFER_TARGET");

      // View-only users cannot transfer at all.
      const viewOnly = await transfer(cookieD, { fromEmployeeId: empD, toEmployeeId: empB, amount: 10, description: "بدون صلاحية تحويل" });
      assert.equal(viewOnly.statusCode, 403, viewOnly.body);

      // Transfer targets endpoint: own-scope sees custody holders only, excluding self.
      const targetsOwn = await app.inject({ method: "GET", url: "/api/cash-custody/transfer-targets", headers: { cookie: cookieA } });
      assert.equal(targetsOwn.statusCode, 200, targetsOwn.body);
      const ownIds = targetsOwn.json().data.map((x: { id: string }) => x.id);
      assert.ok(ownIds.includes(empB), "custody holder B must be listed");
      assert.ok(!ownIds.includes(empC), "employee without custody must not be listed");
      assert.ok(!ownIds.includes(empA), "caller must not be listed as a target");

      // All-scope keeps the full active-employee list and may transfer to anyone active.
      const targetsAll = await app.inject({ method: "GET", url: "/api/cash-custody/transfer-targets", headers: { cookie: cookieMgr } });
      assert.equal(targetsAll.statusCode, 200, targetsAll.body);
      const allIds = targetsAll.json().data.map((x: { id: string }) => x.id);
      for (const id of [empA, empB, empC, empD]) assert.ok(allIds.includes(id), "all-scope must list every active employee");
      const mgrTransfer = await transfer(cookieMgr, { fromEmployeeId: empB, toEmployeeId: empC, amount: 50, description: "تحويل إداري" });
      assert.equal(mgrTransfer.statusCode, 201, mgrTransfer.body);
      assert.equal(await balanceOf(empC), 50);
    } finally {
      await app.close();
    }
  } finally {
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
