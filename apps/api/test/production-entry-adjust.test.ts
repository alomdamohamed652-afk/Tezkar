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

// Entry-time bonus/deduction: shift_leader receives production.entry_adjust (via
// migration 2026112601) and can add a bonus or deduction while registering worker
// production, with the statement (reason) mandatory. Roles holding only
// production.create are denied; production.adjustments.create holders keep working.
test("production entry adjust: shift leader adds bonus/deduction with mandatory reason", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  assert.ok(adminUrl);
  assertDisposableDatabaseUrl(adminUrl);
  const databaseName = "tezkar_entry_adjust_" + randomBytes(6).toString("hex");
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
    process.env.SESSION_SECRET = "test-only-entry-adjust-session-secret-long";
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

    // Migration must have created the permission and granted it to shift_leader.
    const seededGrant = await apiPool.query(
      `SELECT 1 FROM role_permissions rp
         JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
        WHERE r.code='shift_leader' AND p.code='production.entry_adjust'`
    );
    assert.equal(seededGrant.rowCount, 1, "migration grants production.entry_adjust to shift_leader");

    const suffix = randomBytes(4).toString("hex");
    const password = "Test-EntryAdjust-2026!";
    const mkUser = async (username: string) => (await apiPool!.query(
      "INSERT INTO users(username,password_hash,is_active,is_bootstrap,must_complete_setup) VALUES($1,$2,TRUE,FALSE,FALSE) RETURNING id",
      [username, hashPassword(password)]
    )).rows[0];
    const grantPerms = async (userId: string, codes: string[]) => {
      const role = (await apiPool!.query("INSERT INTO roles(code,name) VALUES($1,$2) RETURNING id", ["r_" + randomBytes(4).toString("hex"), "test role"])).rows[0];
      await apiPool!.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [userId, role.id]);
      for (const code of codes) {
        await apiPool!.query("INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2", [role.id, code]);
      }
    };
    const login = async (username: string) => {
      const res = await server.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
      assert.equal(res.statusCode, 200, res.body);
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    };

    const leader = await mkUser("leader-" + suffix);
    await grantPerms(leader.id, ["production.create", "production.view", "production.entry_adjust"]);
    const plain = await mkUser("plain-" + suffix);
    await grantPerms(plain.id, ["production.create"]);
    const adjuster = await mkUser("adjuster-" + suffix);
    await grantPerms(adjuster.id, ["production.create", "production.adjustments.create"]);

    const worker = (await apiPool.query("INSERT INTO employees(full_name) VALUES('Entry Adjust Worker') RETURNING id")).rows[0];
    const unit = (await apiPool.query("SELECT id FROM units WHERE code='PCS' LIMIT 1")).rows[0];
    const rateGroup = (await apiPool.query("INSERT INTO rate_groups(name) VALUES('Entry adjust rate group') RETURNING id")).rows[0];
    const shift = (await apiPool.query(
      "INSERT INTO shifts(name,start_time,end_time,rate_group_id) VALUES('Entry adjust shift','08:00','16:00',$1) RETURNING id",
      [rateGroup.id]
    )).rows[0];
    const stage = (await apiPool.query("INSERT INTO stages(name) VALUES('Entry adjust stage') RETURNING id")).rows[0];
    const product = (await apiPool.query(
      "INSERT INTO products(name,product_type,unit_id) VALUES('Entry adjust product','FINISHED_GOOD',$1) RETURNING id",
      [unit.id]
    )).rows[0];
    const fgWarehouse = (await apiPool.query("SELECT id FROM warehouses WHERE warehouse_type='FINISHED_GOODS' AND is_active=TRUE ORDER BY created_at,id LIMIT 1")).rows[0];
    assert.ok(fgWarehouse, "migrations must create a finished-goods warehouse");
    await apiPool.query(
      "INSERT INTO warehouse_locations(warehouse_id,code,name,is_active) VALUES($1,'ENTRY-ADJUST-FG','Entry adjust FG location',TRUE)",
      [fgWarehouse.id]
    );
    const wageType = (await apiPool.query("SELECT id,code,method FROM wage_types WHERE method='PER_PIECE' LIMIT 1")).rows[0];
    await apiPool.query(
      `INSERT INTO rates(product_id,stage_id,rate_group_id,wage_type_id,unit_id,rate,effective_range,is_active,created_by)
       VALUES($1,$2,$3,$4,$5,10,daterange(CURRENT_DATE-1,CURRENT_DATE+30,'[)'),TRUE,$6)`,
      [product.id, stage.id, rateGroup.id, wageType.id, unit.id, leader.id]
    );
    const workDate = new Date().toISOString().slice(0, 10);

    const leaderCookie = await login("leader-" + suffix);
    const plainCookie = await login("plain-" + suffix);
    const adjusterCookie = await login("adjuster-" + suffix);

    const post = (cookie: string, extra: Record<string, unknown>) => server.inject({
      method: "POST", url: "/api/production", headers: { cookie },
      payload: {
        employeeId: worker.id, productId: product.id, stageId: stage.id, shiftId: shift.id,
        warehouseId: fgWarehouse.id, workDate, quantity: 10, allowDuplicate: true, ...extra
      }
    });

    // 1) Shift leader with entry_adjust: bonus with reason is accepted and recorded.
    const bonusRes = await post(leaderCookie, { bonusAmount: 50, bonusReason: "جودة ممتازة" });
    assert.equal(bonusRes.statusCode, 201, bonusRes.body);
    const bonusEntry = bonusRes.json().data as { id: string; bonus_amount: string | number; total_earning_amount: string | number };
    assert.equal(Number(bonusEntry.bonus_amount), 50);
    assert.equal(Number(bonusEntry.total_earning_amount), 150);
    const bonusAdj = await apiPool.query(
      "SELECT adjustment_type,amount,reason FROM employee_earnings_adjustments WHERE production_entry_id=$1",
      [bonusEntry.id]
    );
    assert.equal(bonusAdj.rowCount, 1);
    assert.equal(bonusAdj.rows[0].adjustment_type, "BONUS");
    assert.equal(Number(bonusAdj.rows[0].amount), 50);
    assert.equal(bonusAdj.rows[0].reason, "جودة ممتازة");

    // 2) Deduction with reason is accepted and netted.
    const deductionRes = await post(leaderCookie, { deductionAmount: 20, deductionReason: "هالك زائد" });
    assert.equal(deductionRes.statusCode, 201, deductionRes.body);
    const deductionEntry = deductionRes.json().data as { id: string; deduction_amount: string | number; total_earning_amount: string | number };
    assert.equal(Number(deductionEntry.deduction_amount), 20);
    assert.equal(Number(deductionEntry.total_earning_amount), 80);

    // 3) Reason is mandatory for both directions.
    const noBonusReason = await post(leaderCookie, { bonusAmount: 50 });
    assert.equal(noBonusReason.statusCode, 422, noBonusReason.body);
    assert.match(noBonusReason.body, /BONUS_REASON_REQUIRED/);
    const noDeductionReason = await post(leaderCookie, { deductionAmount: 20 });
    assert.equal(noDeductionReason.statusCode, 422, noDeductionReason.body);
    assert.match(noDeductionReason.body, /DEDUCTION_REASON_REQUIRED/);

    // 4) Deduction still cannot push net earnings negative.
    const excessive = await post(leaderCookie, { deductionAmount: 5000, deductionReason: "خصم ضخم" });
    assert.equal(excessive.statusCode, 422, excessive.body);
    assert.match(excessive.body, /DEDUCTION_EXCEEDS_EARNING/);

    // 5) production.create alone is denied for adjustments but keeps plain registration.
    const plainBonus = await post(plainCookie, { bonusAmount: 10, bonusReason: "محاولة بدون صلاحية" });
    assert.equal(plainBonus.statusCode, 403, plainBonus.body);
    assert.match(plainBonus.body, /PRODUCTION_ENTRY_ADJUST_FORBIDDEN/);
    const plainCreate = await post(plainCookie, {});
    assert.equal(plainCreate.statusCode, 201, plainCreate.body);

    // 6) Existing adjustments.create holders keep the capability.
    const adjusterRes = await post(adjusterCookie, { bonusAmount: 15, bonusReason: "حافز" });
    assert.equal(adjusterRes.statusCode, 201, adjusterRes.body);
  } finally {
    if (app) await app.close();
    if (apiPool) await apiPool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
