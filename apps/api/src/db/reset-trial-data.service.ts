import { pool } from "./pool.js";

const alwaysKeep = new Set([
  "schema_migrations",
  "departments",
  "job_titles",
  "roles",
  "permissions",
  "role_permissions",
  "rate_groups",
  "units",
  "stages",
  "wage_types",
  "shifts",
  "product_categories",
  "payment_methods",
  "production_types",
  "coding_packaging_types",
  "coding_templates"
]);
const partiallyKeep = new Set([
  "users",
  "user_roles",
  "warehouses",
  "warehouse_locations"
]);

const quoteIdentifier = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
const qualified = (table: string) => '"public".' + quoteIdentifier(table);

export async function resetTrialData(protectedUserId: string | null = null) {
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED");

  const tableResult = await client.query<{ table_name: string }>(
    `SELECT tablename AS table_name
     FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename`
  );
  const allTables = tableResult.rows.map((row) => row.table_name);
  const present = new Set(allTables);

  // Keep any existing settings tables even if their exact name differs by version.
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
    WHERE COALESCE(is_bootstrap, FALSE) = TRUE OR username = 'admin' OR ($1::uuid IS NOT NULL AND id = $1)
  `, [protectedUserId]);

  // Delete all ordinary business/master-data tables child-first. Employees
  // are handled after dependent tables and non-admin users are removed.
  const targets = allTables.filter((table) => !keep.has(table) && table !== "employees");
  const targetSet = new Set(targets);
  const dependencies = await client.query<{ child: string; parent: string }>(
    `SELECT child.relname AS child, parent.relname AS parent
     FROM pg_constraint c
     JOIN pg_class child ON child.oid = c.conrelid
     JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
     JOIN pg_class parent ON parent.oid = c.confrelid
     JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
     WHERE c.contype = 'f'
       AND child_ns.nspname = 'public'
       AND parent_ns.nspname = 'public'`
  );

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>(targets.map((table) => [table, 0]));
  for (const table of targets) outgoing.set(table, new Set());

  for (const { child, parent } of dependencies.rows) {
    if (!targetSet.has(child) || !targetSet.has(parent) || child === parent) continue;
    const edges = outgoing.get(child)!;
    if (!edges.has(parent)) {
      edges.add(parent);
      indegree.set(parent, (indegree.get(parent) ?? 0) + 1);
    }
  }

  const ready = targets.filter((table) => indegree.get(table) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift()!;
    ordered.push(table);
    for (const parent of outgoing.get(table) ?? []) {
      const next = (indegree.get(parent) ?? 0) - 1;
      indegree.set(parent, next);
      if (next === 0) ready.push(parent);
    }
  }
  if (ordered.length !== targets.length) {
    const cyclic = targets.filter((table) => !ordered.includes(table));
    throw new Error(`Foreign-key cycle detected; no data was changed. Tables: ${cyclic.join(", ")}`);
  }

  const deleted: Record<string, number> = {};
  for (const table of ordered) {
    const result = await client.query(`DELETE FROM ${qualified(table)}`);
    deleted[table] = result.rowCount ?? 0;
  }

  // Now all rows referencing trial users/employees have been cleared.
  if (present.has("user_roles")) {
    await client.query(`
      DELETE FROM public.user_roles ur
      WHERE NOT EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = ur.user_id
          AND (COALESCE(u.is_bootstrap, FALSE) = TRUE OR u.username = 'admin' OR ($1::uuid IS NOT NULL AND u.id = $1))
      )`, [protectedUserId]);
  }
  await client.query(`
    DELETE FROM public.users
    WHERE COALESCE(is_bootstrap, FALSE) = FALSE
      AND username <> 'admin'
      AND ($1::uuid IS NULL OR id <> $1)
  `, [protectedUserId]);
  const employeeDelete = await client.query("DELETE FROM public.employees");
  deleted.employees = employeeDelete.rowCount ?? 0;

  // Preserve one base warehouse and, if available, one of its locations.
  // All inventory and movements have already been removed above.
  if (present.has("warehouse_locations")) {
    await client.query(`
      DELETE FROM public.warehouse_locations
      WHERE id <> COALESCE(
        (
          SELECT wl.id
          FROM public.warehouse_locations wl
          JOIN public.warehouses w ON w.id = wl.warehouse_id
          ORDER BY w.created_at NULLS LAST, w.code, wl.created_at NULLS LAST, wl.code
          LIMIT 1
        ),
        '00000000-0000-0000-0000-000000000000'::uuid
      )`);
  }
  await client.query(`
    DELETE FROM public.warehouses
    WHERE id <> COALESCE(
      (SELECT id FROM public.warehouses ORDER BY created_at NULLS LAST, code LIMIT 1),
      '00000000-0000-0000-0000-000000000000'::uuid
    )`);

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

  const afterCounts: Record<string, number> = {};
  for (const table of allTables) {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${qualified(table)}`
    );
    afterCounts[table] = Number(result.rows[0]?.count ?? 0);
  }

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