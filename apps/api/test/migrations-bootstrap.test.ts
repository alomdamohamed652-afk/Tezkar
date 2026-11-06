import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;

test("migrations apply to an empty PostgreSQL database and are idempotent", { skip: !adminUrl && "TEST_DATABASE_URL not set" }, async () => {
  const name = "tezkar_test_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const target = new URL(adminUrl!);
  target.pathname = "/" + name;
  const apiDir = new URL(".", import.meta.url).pathname.replace(/\/test\/$/, "");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: target.toString() },
    encoding: "utf8"
  });

  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /applied:/);

    const verification = new pg.Client({ connectionString: target.toString() });
    await verification.connect();
    try {
      const leader = await verification.query("SELECT id FROM roles WHERE code='shift_leader' AND is_active=TRUE");
      assert.equal(leader.rowCount, 1, "migration must seed the SHIFT_LEADER role");
      const protectedAttendanceTables = [
        "attendance_employee_settings","attendance_weekly_schedule","attendance_schedule_exceptions",
        "attendance_import_batches","attendance_punches","attendance_weekly_schedule_versions",
        "attendance_permission_requests","attendance_day_overrides","payroll_attendance_snapshots",
        "employee_payroll_attendance_policies","payroll_attendance_calculations"
      ];
      const rls = await verification.query(
        `SELECT c.relname,c.relrowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=ANY($1::text[])
          ORDER BY c.relname`,
        [protectedAttendanceTables]
      );
      assert.deepEqual(
        rls.rows,
        [...protectedAttendanceTables].sort().map(relname=>({relname,relrowsecurity:true})),
        "attendance and payroll attendance records must be protected from direct Supabase Data API access"
      );
      const permissionTypeColumn = await verification.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='attendance_permission_requests' AND column_name='permission_type'`
      );
      assert.equal(permissionTypeColumn.rows[0]?.is_nullable,"YES",
        "a pending employee request must not have a pay classification before management reviews it");
      const approvedTypeConstraint = await verification.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid='public.attendance_permission_requests'::regclass AND contype='c'`
      );
      assert.ok(approvedTypeConstraint.rows.some((row:{definition:string})=>/status <> 'APPROVED' OR permission_type IS NOT NULL/.test(row.definition)),
        "an approved permission must always have an explicit paid/unpaid classification");
      const requiredPermissions = [
        "employees.lookup", "orders.view", "products.view", "shifts.view", "rates.view",
        "machines.view", "machine_production.view", "machine_production.create",
        "production.view", "production.create", "warehouse.view",
        "warehouse.receipt.create", "warehouse.shift_withdrawal.create",
        "deliveries.view", "deliveries.create", "cartons.view", "cartons.create"
      ];
      const missing = await verification.query(
        `SELECT code FROM permissions p
          WHERE code=ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM role_permissions rp
               WHERE rp.role_id=$2 AND rp.permission_id=p.id
            )`,
        [requiredPermissions, leader.rows[0].id]
      );
      assert.deepEqual(missing.rows, [], "shift leader must receive all requested operational permissions");
      const excessivePermissions = await verification.query(
        `SELECT p.code FROM role_permissions rp
           JOIN permissions p ON p.id=rp.permission_id
          WHERE rp.role_id=$1
            AND p.code=ANY($2::text[])
          ORDER BY p.code`,
        [leader.rows[0].id, ["employees.view", "machines.create", "warehouse.move", "cartons.manage", "production.approve", "production.edit", "deliveries.release"]]
      );
      assert.deepEqual(excessivePermissions.rows, [], "shift leader must not receive unrelated administrative or approval permissions");
      const missingWorkerPermissions = await verification.query(
        `SELECT p.code
           FROM roles worker
           JOIN role_permissions rp ON rp.role_id=worker.id
           JOIN permissions p ON p.id=rp.permission_id
          WHERE worker.code='worker'
            AND NOT EXISTS (
              SELECT 1 FROM role_permissions leader_rp
              WHERE leader_rp.role_id=$1 AND leader_rp.permission_id=p.id
            )`,
        [leader.rows[0].id]
      );
      assert.deepEqual(missingWorkerPermissions.rows, [], "shift leader must inherit every existing worker permission");
    } finally {
      await verification.end();
    }

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /^applied:/m);
    assert.match(second.stdout, /skipped:/);
  } finally {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
});
