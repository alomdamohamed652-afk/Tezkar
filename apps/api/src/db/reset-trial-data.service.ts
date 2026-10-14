import { pool } from "./pool.js";
import { AppError } from "../http/errors.js";

const alwaysKeep = new Set([
  "schema_migrations",
  "system_reset_events",
  "departments",
  "job_titles",
  "roles",
  "permissions",
  "role_permissions",
  "rate_groups",
  "stages",
  "units",
  "wage_types",
  "shifts",
  "product_categories",
  "payment_methods",
  "production_types",
  "coding_packaging_types",
  "coding_templates",
  "warehouses",
  "warehouse_locations"
]);
const partiallyKeep = new Set([
  "users",
  "user_roles"
]);

// Keep only the stable rows installed by migrations in these configurable
// reference tables; user-created rows in the same tables are reset as well.
const seededReferenceCodes: Record<string, string[]> = {
  departments: ["PROD", "WH", "ADMIN", "HR", "ACC"],
  job_titles: ["WORKER", "SHIFT_LEADER", "PROD_SUPERVISOR", "WAREHOUSE_KEEPER", "WAREHOUSE_MANAGER", "HR_SPECIALIST", "ACCOUNTANT", "MANAGER"],
  rate_groups: ["DEFAULT", "PRODUCTION"],
  shifts: ["MORNING", "EVENING"],
  product_categories: ["PRODUCTS", "RAW_MATERIALS", "PRODUCTION_SUPPLIES", "OPERATING_SUPPLIES"],
  payment_methods: ["CASH", "VODAFONE_CASH", "INSTAPAY", "BANK"],
  units: ["PCS", "KG", "G", "M", "CM", "L", "ML", "BOX", "PACK", "HOUR"],
  wage_types: ["PER_PIECE", "PER_1000", "PER_HOUR", "PER_DAY", "PERCENTAGE_ORDER", "PERCENTAGE_LINE"],
  production_types: ["PRINTING", "PEELING", "PACKING", "PRESSING", "ASSEMBLY", "CUTTING", "UV_PRINTING", "LASER", "OTHER"],
  coding_packaging_types: ["BAG", "CARTON", "SACK", "OTHER"]
};

const seededCodingTemplateNames = ["قالب الكيس", "قالب الكرتونة", "قالب الشيكارة", "قالب عام"];
const seededWarehouseNames = { RAW_MATERIAL: "المخزن الرئيسي للخامات", WIP: "مخزن تحت التشغيل", FINISHED_GOODS: "مخزن المنتجات الجاهزة", SCRAP: "مخزن الهالك" };

const quoteIdentifier = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
const qualified = (table: string) => '"public".' + quoteIdentifier(table);

export async function previewTrialDataReset(protectedUserId: string) {
  const client = await pool.connect();
  try {
    const tableResult = await client.query<{ table_name: string }>(
      `SELECT tablename AS table_name
       FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`
    );
    const allTables = tableResult.rows.map(row => row.table_name);
    const present = new Set(allTables);
    if (!present.has("users") || !present.has("employees") || !present.has("warehouses")) {
      throw new Error("Required Tezkar tables were not found; refusing to preview reset.");
    }

    const keep = new Set(alwaysKeep);
    for (const name of allTables) {
      if (/settings/i.test(name) || /^(company_profile|company_profiles|factory|factories)$/i.test(name)) {
        keep.add(name);
      }
    }
    for (const name of partiallyKeep) keep.add(name);

    const deletedRows: Record<string, number> = {};
    for (const table of allTables) {
      if (seededReferenceCodes[table]) {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${qualified(table)} WHERE code <> ALL($1::text[])`,
          [seededReferenceCodes[table]]
        );
        deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        continue;
      }
      if (table === "roles") {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.roles WHERE is_system = FALSE`
        );
        deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        continue;
      }
      if (table === "role_permissions") {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.role_permissions rp
           JOIN public.roles r ON r.id = rp.role_id WHERE r.is_system = FALSE`
        );
        deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        continue;
      }
      if (table === "coding_templates") {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM (
             SELECT name, row_number() OVER (PARTITION BY name ORDER BY created_at, id) AS position
             FROM public.coding_templates
           ) templates
           WHERE name <> ALL($1::text[]) OR position > 1`,
          [seededCodingTemplateNames]
        );
        deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        continue;
      }
      if (table === "warehouses") {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.warehouses
           WHERE NOT ((warehouse_type = 'RAW_MATERIAL' AND name = $1)
             OR (warehouse_type = 'WIP' AND name = $2)
             OR (warehouse_type = 'FINISHED_GOODS' AND name = $3)
             OR (warehouse_type = 'SCRAP' AND name = $4))`,
          [seededWarehouseNames.RAW_MATERIAL, seededWarehouseNames.WIP, seededWarehouseNames.FINISHED_GOODS, seededWarehouseNames.SCRAP]
        );
        deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        continue;
      }
      if (table === "warehouse_locations") {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.warehouse_locations wl
           WHERE NOT ((wl.code = 'MAIN' OR wl.code = 'SCRAP-MAIN') AND EXISTS (
             SELECT 1 FROM public.warehouses w
             WHERE w.id = wl.warehouse_id AND
               ((w.warehouse_type = 'RAW_MATERIAL' AND w.name = $1)
                OR (w.warehouse_type = 'WIP' AND w.name = $2)
                OR (w.warehouse_type = 'FINISHED_GOODS' AND w.name = $3)
                OR (w.warehouse_type = 'SCRAP' AND w.name = $4))
           )))`,
          [seededWarehouseNames.RAW_MATERIAL, seededWarehouseNames.WIP, seededWarehouseNames.FINISHED_GOODS, seededWarehouseNames.SCRAP]
        );
        deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        continue;
      }
      if (alwaysKeep.has(table) || keep.has(table)) {
        if (table === "users") {
          const result = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM public.users WHERE id <> $1",
            [protectedUserId]
          );
          deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        } else if (table === "user_roles") {
          const result = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM public.user_roles ur
             WHERE ur.user_id <> $1
                OR EXISTS (SELECT 1 FROM public.roles r WHERE r.id = ur.role_id AND r.is_system = FALSE)`,
            [protectedUserId]
          );
          deletedRows[table] = Number(result.rows[0]?.count ?? 0);
        }
        continue;
      }
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${qualified(table)}`
      );
      deletedRows[table] = Number(result.rows[0]?.count ?? 0);
    }
    return {
      deletedRows,
      totalRows: Object.values(deletedRows).reduce((sum, count) => sum + count, 0),
      preservedTables: [...keep].filter(table => present.has(table)).sort()
    };
  } finally {
    client.release();
  }
}

export async function resetTrialData(protectedUserId: string | null = null) {
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('tezkar-one-time-trial-reset'))");
  const priorReset = await client.query<{ used: boolean }>("SELECT EXISTS (SELECT 1 FROM public.system_reset_events WHERE operation_key = 'trial-data-reset') AS used");
  if (priorReset.rows[0]?.used) throw new AppError("RESET_ALREADY_USED", "تم تنفيذ مسح بيانات التجربة بالفعل؛ العملية متاحة مرة واحدة فقط", 409);
  await client.query("SET CONSTRAINTS ALL DEFERRED");

  const tableResult = await client.query<{ table_name: string }>(
    `SELECT tablename AS table_name
     FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename`
  );
  const allTables = tableResult.rows.map((row) => row.table_name);
  const present = new Set(allTables);

  // Preserve only platform/reference configuration. Every other public table is treated as manually entered or operational data and is cleared, including audit/activity logs, notifications, report records, preferences, warehouses, and warehouse locations.
  const keep = new Set(alwaysKeep);
  for (const name of allTables) {
    if (/settings/i.test(name) || /^(company_profile|company_profiles|factory|factories)$/i.test(name)) {
      keep.add(name);
    }
  }
  for (const name of partiallyKeep) keep.add(name);

  if (!present.has("users") || !present.has("employees") || !present.has("warehouses")) {
    throw new Error("Required Tezkar tables were not found; refusing to make any changes.");
  }

  const beforeCounts: Record<string, number> = {};
  for (const table of allTables) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${qualified(table)}`
    );
    beforeCounts[table] = Number(result.rows[0]?.count ?? 0);
  }

  // Revoke old sessions and detach the retained bootstrap/admin user from
  // employee records before clearing business tables. Other trial users are
  // removed only after their dependent audit/task/etc. rows have been cleared.
  if (present.has("user_sessions")) {
    await client.query("DELETE FROM public.user_sessions");
  }
  await client.query(`
    UPDATE public.users
    SET employee_id = NULL
    WHERE ($1::uuid IS NOT NULL AND id = $1)
       OR ($1::uuid IS NULL AND (COALESCE(is_bootstrap, FALSE) = TRUE OR username = 'admin'))
  `, [protectedUserId]);

  // Delete every non-core table child-first. Employees and non-admin users are handled after dependent records are removed.
  const targets = allTables.filter((table) => !keep.has(table) && table !== "employees");
  // Truncate all operational targets together. A single statement safely handles
  // foreign-key cycles between operational tables without cascading into preserved
  // system/reference tables. No CASCADE is used: an unexpected outside dependency
  // aborts the transaction instead of deleting protected data.
  const deleted: Record<string, number> = {};
  if (targets.length > 0) {
    await client.query(`TRUNCATE TABLE ${targets.map(qualified).join(", ")} RESTART IDENTITY`);
  }
  for (const table of targets) deleted[table] = beforeCounts[table] ?? 0;

  // Now all rows referencing trial users/employees have been cleared.
  if (present.has("user_roles")) {
    await client.query(`
      DELETE FROM public.user_roles ur
      WHERE NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = ur.user_id
          AND (($1::uuid IS NOT NULL AND u.id = $1)
               OR ($1::uuid IS NULL AND (COALESCE(u.is_bootstrap, FALSE) = TRUE OR u.username = 'admin')))
      )`, [protectedUserId]);
  }
  await client.query(`
    DELETE FROM public.users
    WHERE ($1::uuid IS NULL AND COALESCE(is_bootstrap, FALSE) = FALSE AND username <> 'admin')
       OR ($1::uuid IS NOT NULL AND id <> $1)
  `, [protectedUserId]);
  const employeeDelete = await client.query("DELETE FROM public.employees");
  deleted.employees = employeeDelete.rowCount ?? 0;

  // Reattach stable defaults to their canonical parents before removing custom rows.
  if (present.has("shifts") && present.has("rate_groups")) {
    await client.query(`
      UPDATE public.shifts
      SET rate_group_id = (SELECT id FROM public.rate_groups WHERE code = 'PRODUCTION')
      WHERE code IN ('MORNING', 'EVENING')
        AND EXISTS (SELECT 1 FROM public.rate_groups WHERE code = 'PRODUCTION')
    `);
  }
  if (present.has("job_titles") && present.has("departments")) {
    await client.query(`
      UPDATE public.job_titles jt
      SET department_id = d.id
      FROM (VALUES
        ('WORKER','PROD'), ('SHIFT_LEADER','PROD'), ('PROD_SUPERVISOR','PROD'),
        ('WAREHOUSE_KEEPER','WH'), ('WAREHOUSE_MANAGER','WH'),
        ('HR_SPECIALIST','HR'), ('ACCOUNTANT','ACC'), ('MANAGER','ADMIN')
      ) AS defaults(title_code, department_code)
      JOIN public.departments d ON d.code = defaults.department_code
      WHERE jt.code = defaults.title_code
    `);
  }

  // Remove user-created rows from reference tables while retaining the known
  // migration-provided defaults needed by the fresh system.
  for (const table of ["job_titles", "departments", "shifts", "rate_groups", "product_categories", "payment_methods"]) {
    if (!present.has(table)) continue;
    const result = await client.query(
      `DELETE FROM ${qualified(table)} WHERE code <> ALL($1::text[])`,
      [seededReferenceCodes[table]]
    );
    deleted[table] = result.rowCount ?? 0;
  }

  // Keep only seeded names in the coding-template catalog.
  if (present.has("coding_templates")) {
    const result = await client.query(
      `DELETE FROM public.coding_templates t
       WHERE t.name <> ALL($1::text[])
          OR t.id IN (
            SELECT id FROM (
              SELECT id, row_number() OVER (PARTITION BY name ORDER BY created_at, id) AS position
              FROM public.coding_templates
              WHERE name = ANY($1::text[])
            ) templates
            WHERE position > 1
          )`,
      [seededCodingTemplateNames]
    );
    deleted.coding_templates = result.rowCount ?? 0;
  }

  // Restore the four shipped label templates, including their settings and package links.
  if (present.has("coding_templates") && present.has("coding_packaging_types")) {
    const defaults = [
      ["قالب الكيس", "BAG", 60, 40, false],
      ["قالب الكرتونة", "CARTON", 80, 50, true],
      ["قالب الشيكارة", "SACK", 100, 60, false],
      ["قالب عام", "OTHER", 80, 50, false]
    ] as const;
    for (const [name, packageCode, width, height, isDefault] of defaults) {
      await client.query(
        `UPDATE public.coding_templates t
         SET packaging_type_id = p.id, width_mm = $3, height_mm = $4,
             orientation = 'LANDSCAPE',
             config = '{"showLogo":true,"showCompanyName":true,"showProduct":true,"showBatch":true,"showQuantity":true,"showWeight":true,"showCode":true,"showBarcode":true,"showPackedDate":true,"showCodedTime":true,"showAddress":true}'::jsonb,
             is_default = $5, is_active = TRUE
         FROM public.coding_packaging_types p
         WHERE t.name = $1 AND p.code = $2`,
        [name, packageCode, width, height, isDefault]
      );
      await client.query(
        `INSERT INTO public.coding_templates(name, packaging_type_id, width_mm, height_mm, orientation, config, is_default, is_active)
         SELECT $1, p.id, $3, $4, 'LANDSCAPE',
           '{"showLogo":true,"showCompanyName":true,"showProduct":true,"showBatch":true,"showQuantity":true,"showWeight":true,"showCode":true,"showBarcode":true,"showPackedDate":true,"showCodedTime":true,"showAddress":true}'::jsonb,
           $5, TRUE
         FROM public.coding_packaging_types p
         WHERE p.code = $2
           AND NOT EXISTS (SELECT 1 FROM public.coding_templates t WHERE t.name = $1)`,
        [name, packageCode, width, height, isDefault]
      );
    }
  }

  // Remove user-created rows from reference catalogs while retaining migration defaults.
  for (const table of ["units", "wage_types", "production_types", "coding_packaging_types"]) {
    if (!present.has(table)) continue;
    const result = await client.query(
      `DELETE FROM ${qualified(table)} WHERE code <> ALL($1::text[])`,
      [seededReferenceCodes[table]]
    );
    deleted[table] = result.rowCount ?? 0;
  }

  // Keep the three canonical system warehouses and their default MAIN locations only.
  if (present.has("warehouse_locations")) {
    const result = await client.query(
      `DELETE FROM public.warehouse_locations wl
       WHERE NOT (wl.code = 'MAIN' AND EXISTS (
         SELECT 1 FROM public.warehouses w
         WHERE w.id = wl.warehouse_id AND
           ((w.warehouse_type = 'RAW_MATERIAL' AND w.name = $1)
            OR (w.warehouse_type = 'WIP' AND w.name = $2)
            OR (w.warehouse_type = 'FINISHED_GOODS' AND w.name = $3))
       ))`,
      [seededWarehouseNames.RAW_MATERIAL, seededWarehouseNames.WIP, seededWarehouseNames.FINISHED_GOODS]
    );
    deleted.warehouse_locations = result.rowCount ?? 0;
  }
  if (present.has("warehouses")) {
    const result = await client.query(
      `DELETE FROM public.warehouses
       WHERE NOT ((warehouse_type = 'RAW_MATERIAL' AND name = $1)
         OR (warehouse_type = 'WIP' AND name = $2)
         OR (warehouse_type = 'FINISHED_GOODS' AND name = $3))`,
      [seededWarehouseNames.RAW_MATERIAL, seededWarehouseNames.WIP, seededWarehouseNames.FINISHED_GOODS]
    );
    deleted.warehouses = result.rowCount ?? 0;

    // Recreate any canonical warehouse that an earlier manual setup replaced.
    await client.query(
      `INSERT INTO public.warehouses(name, warehouse_type, is_active)
       SELECT defaults.name, defaults.warehouse_type, TRUE
       FROM (VALUES
         ($1::text, 'RAW_MATERIAL'::text),
         ($2::text, 'WIP'::text),
         ($3::text, 'FINISHED_GOODS'::text)
       ) AS defaults(name, warehouse_type)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.warehouses w
         WHERE w.warehouse_type = defaults.warehouse_type
           AND w.name = defaults.name
       )`,
      [seededWarehouseNames.RAW_MATERIAL, seededWarehouseNames.WIP, seededWarehouseNames.FINISHED_GOODS]
    );

    await client.query(
      `INSERT INTO public.warehouse_locations(warehouse_id, code, name, is_active)
       SELECT w.id, 'MAIN', 'الرئيسي', TRUE
       FROM public.warehouses w
       WHERE (w.warehouse_type = 'RAW_MATERIAL' AND w.name = $1)
          OR (w.warehouse_type = 'WIP' AND w.name = $2)
          OR (w.warehouse_type = 'FINISHED_GOODS' AND w.name = $3)
       ON CONFLICT (warehouse_id, code) DO NOTHING`,
      [seededWarehouseNames.RAW_MATERIAL, seededWarehouseNames.WIP, seededWarehouseNames.FINISHED_GOODS]
    );
  }

  // Reset owned sequences only when their owning table is now empty, avoiding
  // collisions in retained reference/permission tables.
  const sequences = await client.query<{ sequence_name: string; table_name: string }>(
    `SELECT seq.relname AS sequence_name, tbl.relname AS table_name
     FROM pg_class seq
     JOIN pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
     JOIN pg_depend d ON d.objid = seq.oid AND d.deptype IN ('a', 'i')
     JOIN pg_class tbl ON tbl.oid = d.refobjid
     JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
     WHERE seq.relkind = 'S'
       AND seq_ns.nspname = 'public'
       AND tbl_ns.nspname = 'public'`
  );
  for (const { sequence_name, table_name } of sequences.rows) {
    if (!present.has(table_name) || keep.has(table_name)) continue;
    const remaining = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${qualified(table_name)}`
    );
    if (Number(remaining.rows[0]?.count ?? 0) === 0) {
      await client.query("SELECT setval($1::regclass, 1, false)", [`public.${sequence_name}`]);
    }
  }

  // Custom roles are user-created configuration, not platform roles; remove them and their linked assignments.
  if (present.has("roles")) {
    const result = await client.query("DELETE FROM public.roles WHERE is_system = FALSE");
    deleted.roles = result.rowCount ?? 0;
  }

  const afterCounts: Record<string, number> = {};
  for (const table of allTables) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${qualified(table)}`
    );
    afterCounts[table] = Number(result.rows[0]?.count ?? 0);
  }

  await client.query(
    "INSERT INTO public.system_reset_events(operation_key, actor_user_id, report) VALUES ('trial-data-reset', $1, $2::jsonb)",
    [protectedUserId, JSON.stringify({ deletedRows: deleted, preservedTables: [...keep].filter((table) => present.has(table)).sort() })]
  );
  await client.query("COMMIT");
  return {
    deletedRows: deleted,
    preservedTables: [...keep].filter((table) => present.has(table)).sort(),
    beforeCounts,
    afterCounts
  };
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Tezkar trial-data reset rolled back; no partial changes were committed.");
  throw error;
} finally {
  client.release();
}
}