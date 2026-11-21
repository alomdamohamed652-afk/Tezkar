import pg from "pg";
import { buildTransferOrder } from "./data-transfer-plan.js";

const { Pool } = pg;
let legacyPool: pg.Pool | null = null;

function getLegacyPool(): pg.Pool {
  const connectionString = process.env.LEGACY_DATABASE_URL;
  if (!connectionString) throw new Error("LEGACY_DATABASE_URL is not configured");
  if (!legacyPool) {
    legacyPool = new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      options: "-c default_transaction_read_only=on"
    });
    legacyPool.on("error", error => {
      // Never log connection strings or credentials.
      console.error("Legacy read-only database pool error", error.message);
    });
  }
  return legacyPool;
}

type Column = { name: string; dataType: string; udtName: string; nullable: boolean; defaultValue: string | null; ordinal: number; maxLength: number | null; numericPrecision: number | null; numericScale: number | null; datetimePrecision: number | null; identity: string; generated: string };
type Table = { name: string; kind: string; columns: Column[]; primaryKey: string[]; rowEstimate: number; rlsEnabled: boolean; rlsForced: boolean };
type ForeignKey = { table: string; name: string; columns: string[]; referencedTable: string; referencedColumns: string[]; deferrable: boolean; initiallyDeferred: boolean; onUpdate: string; onDelete: string };

async function inspect(pool: pg.Pool, requireRestrictedRole = false) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const safety = await client.query<{ readOnly: boolean; superuser: boolean; bypassRls: boolean; roleName: string }>(`
      SELECT current_setting('transaction_read_only') = 'on' AS "readOnly",
             r.rolsuper AS superuser, r.rolbypassrls AS "bypassRls", current_user AS "roleName"
        FROM pg_roles r WHERE r.rolname = current_user
    `);
    if (safety.rows[0]?.readOnly !== true) throw new Error("Legacy source transaction is not read-only");
    if (requireRestrictedRole && (safety.rows[0]?.superuser || safety.rows[0]?.bypassRls)) {
      throw new Error("Legacy source role must not be superuser or BYPASSRLS");
    }
    const additionalSchemasResult = await client.query<{ schema_name: string }>(`
      SELECT nspname AS schema_name
        FROM pg_namespace
       WHERE nspname <> 'public'
         AND nspname <> 'information_schema'
         AND nspname NOT LIKE 'pg_%'
         AND nspname NOT IN ('auth','storage','realtime','extensions','vault','graphql_public','supabase_functions','supabase_migrations','_realtime','net','cron','pgsodium')
       ORDER BY nspname
    `);
    const tablesResult = await client.query<{ name: string; kind: string; estimate: string; rls_enabled: boolean; rls_forced: boolean }>(`
      SELECT c.relname AS name, c.relkind AS kind,
             GREATEST(c.reltuples, 0)::bigint::text AS estimate,
             c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')
       ORDER BY c.relname
    `);
    const columnsResult = await client.query<{
      table_name: string; column_name: string; data_type: string; udt_name: string;
      is_nullable: string; column_default: string | null; ordinal_position: number;
      character_maximum_length: number | null; numeric_precision: number | null;
      numeric_scale: number | null; datetime_precision: number | null;
      identity_generation: string | null; is_generated: string;
    }>(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable,
             column_default, ordinal_position, character_maximum_length,
             numeric_precision, numeric_scale, datetime_precision,
             identity_generation, is_generated
        FROM information_schema.columns
       WHERE table_schema='public'
       ORDER BY table_name, ordinal_position
    `);
    const pkResult = await client.query<{ table_name: string; column_name: string; ordinal: number }>(`
      SELECT tc.table_name, kcu.column_name, kcu.ordinal_position AS ordinal
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema AND tc.table_name=kcu.table_name
       WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY'
       ORDER BY tc.table_name, kcu.ordinal_position
    `);
    const sequenceResult = await client.query<{ table_name: string; column_name: string; sequence_name: string | null }>(`
      SELECT table_name, column_name,
             pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS sequence_name
        FROM information_schema.columns
       WHERE table_schema='public' AND (column_default LIKE 'nextval(%' OR is_identity='YES')
       ORDER BY table_name, ordinal_position
    `);
    const featureResult = await client.query<{
      views: number; materializedViews: number; triggers: number; extensions: number; sequences: number; largeObjects: number;
      customTypes: number; routines: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v') AS views,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='m') AS "materializedViews",
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) AS triggers,
        (SELECT count(*)::int FROM pg_extension) AS extensions,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S') AS sequences,
        (SELECT count(*)::int FROM pg_largeobject_metadata) AS "largeObjects",
        (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d','r','m','c') AND (t.typtype <> 'c' OR NOT EXISTS (SELECT 1 FROM pg_class row_type WHERE row_type.reltype=t.oid AND row_type.relkind IN ('r','p','v','m','f')))) AS "customTypes",
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS routines
    `);
    const extensionResult = await client.query<{ name: string; version: string }>(`
      SELECT extname AS name, extversion AS version
        FROM pg_extension
       ORDER BY extname
    `);
    const customTypeResult = await client.query<{ type_name: string; type_kind: string; definition: string; enum_labels: string[] }>(`
      SELECT t.typname AS type_name, t.typtype::text AS type_kind,
             CASE
               WHEN t.typtype = 'd' THEN format('base=%s;notnull=%s;default=%s;checks=%s', format_type(t.typbasetype, t.typtypmod), t.typnotnull, COALESCE(t.typdefault, ''), COALESCE(domain_checks.definitions, ''))
               WHEN t.typtype = 'r' THEN format('range_subtype=%s;collation=%s;canonical=%s;subtype_diff=%s',
                 format_type(r.rngsubtype, NULL), COALESCE(coll.collname, ''), COALESCE(r.rngcanonical::regproc::text, ''), COALESCE(r.rngsubdiff::regproc::text, ''))
               ELSE t.typtype::text
             END AS definition,
             COALESCE(enum_values.labels, ARRAY[]::text[]) AS enum_labels
        FROM pg_type t
        JOIN pg_namespace ns ON ns.oid=t.typnamespace
        LEFT JOIN pg_range r ON r.rngtypid=t.oid OR r.rngmultitypid=t.oid
        LEFT JOIN pg_collation coll ON coll.oid=r.rngcollation
        LEFT JOIN LATERAL (
          SELECT string_agg(pg_get_constraintdef(con.oid, true), ';' ORDER BY con.conname) AS definitions
            FROM pg_constraint con WHERE con.contypid=t.oid
        ) domain_checks ON true
        LEFT JOIN LATERAL (
          SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
            FROM pg_enum e WHERE e.enumtypid=t.oid
        ) enum_values ON true
       WHERE ns.nspname='public' AND t.typtype IN ('e','d','r','m','c')
         AND (t.typtype <> 'c' OR NOT EXISTS (SELECT 1 FROM pg_class row_type WHERE row_type.reltype=t.oid AND row_type.relkind IN ('r','p','v','m','f')))
       ORDER BY t.typname
    `);
    const constraintResult = await client.query<{ table_name: string; constraint_type: string; definition: string }>(`
      SELECT c.relname AS table_name, con.contype::text AS constraint_type,
             pg_get_constraintdef(con.oid, true) AS definition
        FROM pg_constraint con
        JOIN pg_class c ON c.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND con.contype IN ('u','c','x')
       ORDER BY c.relname, con.contype, pg_get_constraintdef(con.oid, true)
    `);
    const uniqueIndexResult = await client.query<{ table_name: string; definition: string }>(`
      SELECT tbl.relname AS table_name, pg_get_indexdef(idx.indexrelid, 0, true) AS definition
        FROM pg_index idx
        JOIN pg_class tbl ON tbl.oid=idx.indrelid
        JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
       WHERE ns.nspname='public' AND idx.indisunique AND NOT idx.indisprimary
       ORDER BY tbl.relname, pg_get_indexdef(idx.indexrelid, 0, true)
    `);
    const triggerResult = await client.query<{ table_name: string; definition: string; enabled: string }>(`
      SELECT tbl.relname AS table_name, pg_get_triggerdef(t.oid, true) AS definition,
             t.tgenabled AS enabled
        FROM pg_trigger t
        JOIN pg_class tbl ON tbl.oid=t.tgrelid
        JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
       WHERE ns.nspname='public' AND NOT t.tgisinternal
       ORDER BY tbl.relname, t.tgname
    `);
    const policyResult = await client.query<{ table_name: string; policy_name: string; command: string; roles: string[]; using_expression: string | null; check_expression: string | null }>(`
      SELECT tablename AS table_name, policyname AS policy_name, cmd AS command,
             roles, qual AS using_expression, with_check AS check_expression
        FROM pg_policies WHERE schemaname='public'
       ORDER BY tablename, policyname
    `);
    const fkResult = await client.query<{
      table_name: string; constraint_name: string; column_name: string;
      foreign_table_name: string; foreign_table_schema: string; foreign_column_name: string; ordinal: number;
      deferrable: boolean; initially_deferred: boolean; update_rule: string; delete_rule: string;
    }>(`
      SELECT src.relname AS table_name, con.conname AS constraint_name,
             src_col.attname AS column_name, dst.relname AS foreign_table_name,
             dst_ns.nspname AS foreign_table_schema,
             dst_col.attname AS foreign_column_name, key.ordinality::int AS ordinal,
             con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
             CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
               WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule,
             CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
               WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
        FROM pg_constraint con
        JOIN pg_class src ON src.oid=con.conrelid
        JOIN pg_namespace ns ON ns.oid=src.relnamespace
        JOIN pg_class dst ON dst.oid=con.confrelid
        JOIN pg_namespace dst_ns ON dst_ns.oid=dst.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
          WITH ORDINALITY AS key(src_attnum, dst_attnum, ordinality)
        JOIN pg_attribute src_col ON src_col.attrelid=src.oid AND src_col.attnum=key.src_attnum
        JOIN pg_attribute dst_col ON dst_col.attrelid=dst.oid AND dst_col.attnum=key.dst_attnum
       WHERE ns.nspname='public' AND con.contype='f'
       ORDER BY src.relname, con.conname, key.ordinality
    `);
    const columnsByTable = new Map<string, Column[]>();
    for (const c of columnsResult.rows) {
      const list = columnsByTable.get(c.table_name) ?? [];
      list.push({ name: c.column_name, dataType: c.data_type, udtName: c.udt_name, nullable: c.is_nullable === "YES", defaultValue: c.column_default, ordinal: c.ordinal_position, maxLength: c.character_maximum_length, numericPrecision: c.numeric_precision, numericScale: c.numeric_scale, datetimePrecision: c.datetime_precision, identity: c.identity_generation ?? "", generated: c.is_generated ?? "NEVER" });
      columnsByTable.set(c.table_name, list);
    }
    const pkByTable = new Map<string, string[]>();
    for (const p of pkResult.rows) {
      const list = pkByTable.get(p.table_name) ?? [];
      list.push(p.column_name);
      pkByTable.set(p.table_name, list);
    }
    const tables: Table[] = tablesResult.rows.map(t => ({
      name: t.name, kind: t.kind === "p" ? "partitioned" : "table",
      columns: columnsByTable.get(t.name) ?? [], primaryKey: pkByTable.get(t.name) ?? [],
      rowEstimate: Number(t.estimate), rlsEnabled: t.rls_enabled, rlsForced: t.rls_forced
    }));
    const fkGroups = new Map<string, ForeignKey>();
    for (const f of fkResult.rows) {
      const key = f.table_name + "." + f.constraint_name;
      const group = fkGroups.get(key) ?? {
        table: f.table_name, name: f.constraint_name, columns: [],
        referencedTable: f.foreign_table_schema === "public" ? f.foreign_table_name : `${f.foreign_table_schema}.${f.foreign_table_name}`, referencedColumns: [],
        deferrable: f.deferrable,
        initiallyDeferred: f.initially_deferred,
        onUpdate: f.update_rule,
        onDelete: f.delete_rule
      };
      group.columns.push(f.column_name);
      group.referencedColumns.push(f.foreign_column_name);
      fkGroups.set(key, group);
    }
    await client.query("COMMIT");
    return { tables, foreignKeys: [...fkGroups.values()], constraints: constraintResult.rows, customTypes: customTypeResult.rows, extensions: extensionResult.rows, uniqueIndexes: uniqueIndexResult.rows, triggers: triggerResult.rows, policies: policyResult.rows, sequences: sequenceResult.rows, additionalSchemas: additionalSchemasResult.rows.map(row => row.schema_name), features: featureResult.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function inspectLegacyAndTarget(targetPool: pg.Pool) {
  const source = getLegacyPool();
  const [legacy, target] = await Promise.all([inspect(source, true), inspect(targetPool)]);
  const targetByName = new Map(target.tables.map(table => [table.name, table]));
  const legacyByName = new Map(legacy.tables.map(table => [table.name, table]));
  const allNames = [...new Set([...legacyByName.keys(), ...targetByName.keys()])].sort();
  const fkSignature = (items: ForeignKey[], tableName: string) => items
    .filter(item => item.table === tableName)
    .map(item => JSON.stringify([item.columns, item.referencedTable, item.referencedColumns, item.deferrable, item.initiallyDeferred, item.onUpdate, item.onDelete]))
    .sort();
  const constraintSignature = (items: Array<{table_name: string; constraint_type: string; definition: string}>, tableName: string) =>
    items.filter(item => item.table_name === tableName)
      .map(item => JSON.stringify([item.constraint_type, item.definition])).sort();
  const objectSignature = (items: Array<{table_name: string; definition: string; enabled?: string}>, tableName: string) =>
    items.filter(item => item.table_name === tableName)
      .map(item => JSON.stringify([item.definition, item.enabled ?? null])).sort();
  const policySignature = (items: Array<{table_name: string; policy_name: string; command: string; roles: string[]; using_expression: string | null; check_expression: string | null}>, tableName: string) =>
    items.filter(item => item.table_name === tableName)
      .map(item => JSON.stringify([item.policy_name, item.command, item.roles, item.using_expression, item.check_expression])).sort();
  const typeSignature = (items: Array<{type_name: string; type_kind: string; definition: string; enum_labels: string[]}>) =>
    items.map(item => JSON.stringify([item.type_name, item.type_kind, item.definition, item.enum_labels])).sort();
  const customTypeDifferences = JSON.stringify(typeSignature(legacy.customTypes)) !== JSON.stringify(typeSignature(target.customTypes))
    ? ["اختلاف تعريفات الأنواع المخصصة (ENUM/DOMAIN/RANGE/COMPOSITE)؛ لا يمكن ضمان إدخال قيمها دون تطابق التعريفات"]
    : [];
  const extensionSignature = (items: Array<{name: string; version: string}>) =>
    items.map(item => JSON.stringify([item.name, item.version])).sort();
  const extensionDifferences = JSON.stringify(extensionSignature(legacy.extensions)) !== JSON.stringify(extensionSignature(target.extensions))
    ? ["اختلاف أسماء أو إصدارات PostgreSQL Extensions بين المصدر والوجهة؛ يلزم توحيدها قبل النقل"]
    : [];
  const globalBlockers = [
    ...customTypeDifferences,
    ...extensionDifferences,
    ...(legacy.additionalSchemas.length
      ? [`توجد مخططات غير مفحوصة في المصدر: ${legacy.additionalSchemas.join(", ")}؛ لا يمكن ضمان اكتمال النقل`]
      : []),
    ...(target.additionalSchemas.length
      ? [`توجد مخططات غير مفحوصة في الوجهة: ${target.additionalSchemas.join(", ")}؛ لا يمكن ضمان عدم وجود تعارضات`]
      : [])
  ];
  type UnsupportedFeatureKey = "views" | "materializedViews" | "routines" | "largeObjects" | "triggers";
  const unsupportedObjects: Array<[UnsupportedFeatureKey, string]> = [
    ["views", "Views"],
    ["materializedViews", "Materialized Views"],
    ["routines", "Functions/Procedures"],
    ["largeObjects", "Large Objects"],
    ["triggers", "Triggers"]
  ];
  for (const [key, label] of unsupportedObjects) {
    const sourceCount = Number(legacy.features?.[key] ?? 0);
    const targetCount = Number(target.features?.[key] ?? 0);
    if (sourceCount > 0 || targetCount > 0) {
      globalBlockers.push(`وجود ${label} (المصدر: ${sourceCount}، الوجهة: ${targetCount})؛ لا يوجد لها مسار نقل آمن مكتمل حتى الآن`);
    }
  }
  if (legacy.customTypes.length > 0 || target.customTypes.length > 0) {
    globalBlockers.push("توجد أنواع PostgreSQL مخصصة؛ يلزم دعم نقلها والتحقق منها صراحةً قبل السماح بنقل البيانات");
  }
  if (Number(legacy.features?.sequences ?? 0) > 0 || Number(target.features?.sequences ?? 0) > 0) {
    globalBlockers.push("توجد Sequences (بما فيها المستقلة غير المرتبطة بأعمدة)؛ مزامنة قيمها النهائية والتحقق منها لم تُنفذ بعد");
  }
  const comparison = allNames.map(name => {
    const from = legacyByName.get(name);
    const to = targetByName.get(name);
    if (!from) return { table: name, status: "target_only", sourceEstimate: 0, targetEstimate: to!.rowEstimate, differences: ["الجدول موجود في الوجهة فقط"] };
    if (!to) return { table: name, status: "source_only", sourceEstimate: from.rowEstimate, targetEstimate: 0, differences: ["الجدول غير موجود في الوجهة؛ يلزم مراجعة المخطط قبل النقل"] };
    const differences: string[] = [];
    const sourceColumns = new Map(from.columns.map(c => [c.name, c]));
    const targetColumns = new Map(to.columns.map(c => [c.name, c]));
    for (const c of from.columns) {
      const other = targetColumns.get(c.name);
      if (!other) differences.push("عمود غير موجود بالوجهة: " + c.name);
      else {
        if (c.udtName !== other.udtName || c.dataType !== other.dataType || c.maxLength !== other.maxLength || c.numericPrecision !== other.numericPrecision || c.numericScale !== other.numericScale || c.datetimePrecision !== other.datetimePrecision) differences.push("اختلاف نوع أو دقة العمود: " + c.name);
        if (c.nullable && !other.nullable) differences.push("الوجهة تمنع NULL بينما المصدر يسمح به في العمود: " + c.name);
        if (c.defaultValue !== other.defaultValue) differences.push("اختلاف القيمة الافتراضية للعمود: " + c.name);
        if (c.identity !== other.identity || c.generated !== other.generated) differences.push("اختلاف خصائص Identity/Generated للعمود: " + c.name);
      }
    }
    for (const c of to.columns) if (!sourceColumns.has(c.name) && !c.nullable && c.defaultValue === null) differences.push("عمود إلزامي إضافي بالوجهة: " + c.name);
    if (from.primaryKey.length === 0) differences.push("جدول المصدر بلا مفتاح أساسي؛ لا يمكن ضمان نقل آمن قابل للاستئناف");
    if (from.kind === "partitioned") differences.push("الجدول مقسّم إلى partitions؛ النقل الآلي متوقف لحين معالجة التقسيم صراحةً");
    if (JSON.stringify(from.primaryKey) !== JSON.stringify(to.primaryKey)) differences.push("اختلاف المفتاح الأساسي");
    if (JSON.stringify(fkSignature(legacy.foreignKeys, name)) !== JSON.stringify(fkSignature(target.foreignKeys, name))) differences.push("اختلاف علاقات المفاتيح الخارجية");
    if (JSON.stringify(constraintSignature(legacy.constraints, name)) !== JSON.stringify(constraintSignature(target.constraints, name))) differences.push("اختلاف قيود UNIQUE أو CHECK أو EXCLUDE");
    if (JSON.stringify(objectSignature(legacy.uniqueIndexes, name)) !== JSON.stringify(objectSignature(target.uniqueIndexes, name))) differences.push("اختلاف الفهارس الفريدة UNIQUE INDEX");
    if (JSON.stringify(objectSignature(legacy.triggers, name)) !== JSON.stringify(objectSignature(target.triggers, name))) differences.push("اختلاف Triggers؛ قد تؤثر في السجلات أثناء الإدخال");
    if (JSON.stringify(policySignature(legacy.policies, name)) !== JSON.stringify(policySignature(target.policies, name))) differences.push("اختلاف سياسات Row Level Security");
    if (from.columns.some(column => column.identity || column.generated !== "NEVER")) differences.push("يحتوي المصدر على أعمدة Identity أو Generated؛ يلزم مسار إدخال مخصص قبل النقل");
    if (from.rlsEnabled) differences.push("RLS مفعّل في المصدر؛ لا يمكن ضمان رؤية كل الصفوف بحساب القراءة الحالي دون إثبات تغطية السياسات");
    if (to.rlsEnabled) differences.push("RLS مفعّل في الوجهة؛ لا يمكن ضمان نجاح إدخال كل السجلات بحساب النقل الحالي");
    if (from.kind !== to.kind) differences.push("اختلاف نوع الجدول");
    if (from.rlsEnabled !== to.rlsEnabled || from.rlsForced !== to.rlsForced) differences.push("اختلاف إعدادات Row Level Security");
    return { table: name, status: differences.length ? "schema_mismatch" : "compatible", sourceEstimate: from.rowEstimate, targetEstimate: to.rowEstimate, differences };
  });
  const unsafeTables = comparison
    .filter(item => item.status === "source_only" || item.status === "schema_mismatch")
    .map(item => item.table);
  const transferPlan = buildTransferOrder(
    legacy.tables.map(table => ({ name: table.name, primaryKey: table.primaryKey })),
    legacy.foreignKeys.map(fk => ({
      table: fk.table,
      referencedTable: fk.referencedTable,
      deferrable: fk.deferrable,
      initiallyDeferred: fk.initiallyDeferred
    })),
    unsafeTables
  );
  globalBlockers.push(...transferPlan.blockers.map(message => `ترتيب النقل: ${message}`));
  return {
    source: { tableCount: legacy.tables.length, estimatedRows: legacy.tables.reduce((n,t)=>n+t.rowEstimate,0), foreignKeyCount: legacy.foreignKeys.length },
    target: { tableCount: target.tables.length, estimatedRows: target.tables.reduce((n,t)=>n+t.rowEstimate,0), foreignKeyCount: target.foreignKeys.length },
    comparison,
    foreignKeys: legacy.foreignKeys,
    transferPlan,
    sourceConstraints: legacy.constraints,
    targetConstraints: target.constraints,
    sourceUniqueIndexes: legacy.uniqueIndexes,
    targetUniqueIndexes: target.uniqueIndexes,
    sourceTriggers: legacy.triggers,
    targetTriggers: target.triggers,
    sourcePolicies: legacy.policies,
    targetPolicies: target.policies,
    sourceFeatures: legacy.features,
    targetFeatures: target.features,
    sourceExtensions: legacy.extensions,
    targetExtensions: target.extensions,
    sourceCustomTypes: legacy.customTypes,
    targetCustomTypes: target.customTypes,
    globalBlockers,
    sourceSequences: legacy.sequences,
    targetSequences: target.sequences,
    blockers: [
      ...comparison.filter(x => x.status === "source_only" || x.status === "schema_mismatch").map(x => ({ table: x.table, status: x.status, differences: x.differences })),
      ...globalBlockers.map(message => ({ table: null, status: "global_transfer_blocker", differences: [message] }))
    ],
    note: "أعداد الصفوف تقديرية من إحصاءات PostgreSQL وليست عدًّا دقيقًا. هذه المرحلة قراءة فقط ولا تنقل أو تعدّل أي بيانات."
  };
}

export async function closeLegacyPool() {
  if (legacyPool) {
    const current = legacyPool;
    legacyPool = null;
    await current.end();
  }
}
