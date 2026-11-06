import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;

test("trial reset removes manual operational/catalog data and preserves manager plus system defaults", {
  skip: !adminUrl && "TEST_DATABASE_URL not set"
}, async () => {
  const databaseName = "tezkar_reset_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  await admin.end();

  const target = new URL(adminUrl!);
  target.pathname = "/" + databaseName;
  const apiDir = new URL("../", import.meta.url).pathname;
  const env = {
    ...process.env,
    DATABASE_URL: target.toString(),
    BOOTSTRAP_ADMIN_USERNAME: "admin",
    BOOTSTRAP_ADMIN_PASSWORD: "TestResetAdminPassword!123"
  };
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, args, { cwd: apiDir, env: { ...env, ...extraEnv }, encoding: "utf8" });

  try {
    const migration = run(["--import", "tsx", "src/db/migrate.ts"]);
    assert.equal(migration.status, 0, migration.stderr);

    const bootstrap = run(["--import", "tsx", "src/db/bootstrap-admin.ts"]);
    assert.equal(bootstrap.status, 0, bootstrap.stderr);

    const db = new pg.Client({ connectionString: target.toString() });
    await db.connect();
    let managerId = "";
    try {
      const manager = await db.query<{ id: string }>("SELECT id FROM public.users WHERE username = 'admin'");
      managerId = manager.rows[0]?.id ?? "";
      assert.ok(managerId, "bootstrap admin should exist");

      await db.query("INSERT INTO public.departments(code, name) VALUES ('TEST_CUSTOM_DEPT', 'قسم تجريبي')");
      await db.query("INSERT INTO public.employees(full_name, department_id) SELECT 'موظف تجريبي', id FROM public.departments WHERE code = 'TEST_CUSTOM_DEPT'");
      await db.query("INSERT INTO public.units(code, name) VALUES ('TEST_CUSTOM_UNIT', 'وحدة تجريبية')");
      await db.query("INSERT INTO public.production_types(code, name, calculation_method) VALUES ('TEST_CUSTOM_TYPE', 'نوع تجريبي', 'PER_QUANTITY')");
      await db.query("INSERT INTO public.coding_packaging_types(code, name) VALUES ('TEST_CUSTOM_PACKAGE', 'تغليف تجريبي')");
      await db.query("INSERT INTO public.coding_templates(name, width_mm, height_mm) VALUES ('قالب تجريبي مخصص', 80, 50)");
      const customWarehouse = await db.query<{ id: string }>(
        "INSERT INTO public.warehouses(name, warehouse_type) VALUES ('مخزن تجريبي مخصص', 'GENERAL') RETURNING id"
      );
      await db.query(
        "INSERT INTO public.warehouse_locations(warehouse_id, code, name) VALUES ($1, 'TEST', 'موقع تجريبي')",
        [customWarehouse.rows[0].id]
      );
      const customScrapWarehouse = await db.query<{ id: string }>(
        "INSERT INTO public.warehouses(name, warehouse_type) VALUES ('مخزن هالك تجريبي', 'SCRAP') RETURNING id"
      );
      await db.query(
        "INSERT INTO public.warehouse_locations(warehouse_id, code, name) VALUES ($1, 'SCRAP-TEST', 'مكان هالك تجريبي')",
        [customScrapWarehouse.rows[0].id]
      );
      const customRole = await db.query<{ id: string }>(
        "INSERT INTO public.roles(code, name, is_system) VALUES ('test_custom_role', 'دور تجريبي', FALSE) RETURNING id"
      );
      await db.query(
        "INSERT INTO public.role_permissions(role_id, permission_id) SELECT $1, id FROM public.permissions WHERE code = 'audit.view'",
        [customRole.rows[0].id]
      );
      await db.query(
        "INSERT INTO public.audit_log(actor_user_id, action, module, entity_type) VALUES ($1, 'TEST_RESET', 'test', 'test')",
        [managerId]
      );
    } finally {
      await db.end();
    }

    const resetScript = `
      import { pool } from './src/db/pool.ts';
      import { previewTrialDataReset, resetTrialData } from './src/db/reset-trial-data.service.ts';
      try {
        const managerId = process.env.RESET_TEST_ADMIN_ID;
        const preview = await previewTrialDataReset(managerId);
        const report = await resetTrialData(managerId);
        console.log(JSON.stringify({ preview, report }));
      } finally {
        await pool.end();
      }
    `;
    const reset = run(["--import", "tsx", "--input-type=module", "-e", resetScript], { RESET_TEST_ADMIN_ID: managerId });
    assert.equal(reset.status, 0, reset.stderr);
    const output = JSON.parse(reset.stdout.trim());

    assert.equal(output.preview.deletedRows.departments, 1);
    assert.equal(output.preview.deletedRows.units, 1);
    assert.equal(output.preview.deletedRows.production_types, 1);
    assert.equal(output.preview.deletedRows.coding_packaging_types, 1);
    assert.equal(output.preview.deletedRows.coding_templates, 1);
    assert.equal(output.preview.deletedRows.warehouses, 1);
    assert.equal(output.preview.deletedRows.warehouse_locations, 1);
    assert.equal(output.preview.deletedRows.roles, 1);
    assert.equal(output.preview.deletedRows.role_permissions, 1);

    const verify = new pg.Client({ connectionString: target.toString() });
    await verify.connect();
    try {
      const count = async (sql: string, params: unknown[] = []) => {
        const result = await verify.query<{ count: string }>(sql, params);
        return Number(result.rows[0]?.count ?? 0);
      };
      assert.equal(await count("SELECT count(*)::text AS count FROM public.users WHERE id = $1", [managerId]), 1);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.user_roles WHERE user_id = $1 AND role_id = (SELECT id FROM public.roles WHERE code = 'manager')", [managerId]), 1);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.employees"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.audit_log"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.departments WHERE code = 'TEST_CUSTOM_DEPT'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.units WHERE code = 'TEST_CUSTOM_UNIT'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.production_types WHERE code = 'TEST_CUSTOM_TYPE'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.coding_packaging_types WHERE code = 'TEST_CUSTOM_PACKAGE'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.coding_templates WHERE name = 'قالب تجريبي مخصص'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.warehouses WHERE name = 'مخزن تجريبي مخصص'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.warehouse_locations WHERE code = 'TEST'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.roles WHERE code = 'test_custom_role'"), 0);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.units WHERE code = 'PCS'"), 1);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.production_types WHERE code = 'PRINTING'"), 1);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.coding_packaging_types WHERE code = 'BAG'"), 1);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.coding_templates WHERE name IN ('قالب الكيس','قالب الكرتونة','قالب الشيكارة','قالب عام')"), 4);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.coding_templates WHERE name = 'قالب الكرتونة' AND is_default = TRUE AND width_mm = 80 AND height_mm = 50"), 1);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.warehouses WHERE warehouse_type IN ('RAW_MATERIAL','WIP','FINISHED_GOODS')"), 3);
      assert.equal(await count("SELECT count(*)::text AS count FROM public.warehouses WHERE warehouse_type = 'SCRAP'"), 2, "system and custom scrap warehouses must survive trial reset");
      assert.equal(await count("SELECT count(*)::text AS count FROM public.warehouse_locations WHERE code = 'SCRAP-TEST'"), 1, "custom scrap warehouse locations must survive trial reset");
      assert.equal(await count("SELECT count(*)::text AS count FROM public.warehouse_locations WHERE code = 'SCRAP-MAIN'"), 1, "default scrap warehouse location must survive trial reset");
      assert.equal(await count("SELECT count(*)::text AS count FROM public.system_reset_events WHERE operation_key = 'trial-data-reset'"), 1);
    } finally {
      await verify.end();
    }
  } finally {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await cleanup.end();
  }
});
