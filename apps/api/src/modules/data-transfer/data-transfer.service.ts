import pg from "pg";

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

type Column = { name: string; dataType: string; udtName: string; nullable: boolean; defaultValue: string | null; ordinal: number; maxLength: number | null; numericPrecision: number | null; numericScale: number | null; datetimePrecision: number | null };
type Table = { name: string; kind: string; columns: Column[]; primaryKey: string[]; rowEstimate: number };
type ForeignKey = { table: string; name: string; columns: string[]; referencedTable: string; referencedColumns: string[]; deferrable: boolean };

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
    const tablesResult = await client.query<{ name: string; kind: string; estimate: string }>(`
      SELECT c.relname AS name, c.relkind AS kind,
             GREATEST(c.reltuples, 0)::bigint::text AS estimate
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')
       ORDER BY c.relname
    `);
    const columnsResult = await client.query<{
      table_name: string; column_name: string; data_type: string; udt_name: string;
      is_nullable: string; column_default: string | null; ordinal_position: number;
      character_maximum_length: number | null; numeric_precision: number | null;
      numeric_scale: number | null; datetime_precision: number | null;
    }>(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable,
             column_default, ordinal_position, character_maximum_length,
             numeric_precision, numeric_scale, datetime_precision
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
      views: number; materializedViews: number; triggers: number; extensions: number; largeObjects: number;
      customTypes: number; routines: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v') AS views,
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='m') AS "materializedViews",
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) AS triggers,
        (SELECT count(*)::int FROM pg_extension) AS extensions,
        (SELECT count(*)::int FROM pg_largeobject_metadata) AS "largeObjects",
        (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d','r','m')) AS "customTypes",
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS routines
    `);
    const fkResult = await client.query<{
      table_name: string; constraint_name: string; column_name: string;
      foreign_table_name: string; foreign_column_name: string; ordinal: number; is_deferrable: string;
    }>(`
      SELECT tc.table_name, tc.constraint_name, kcu.column_name,
             ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name,
             kcu.ordinal_position AS ordinal, tc.is_deferrable
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
       WHERE tc.constraint_schema='public' AND tc.constraint_type='FOREIGN KEY'
       ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
    `);
    const columnsByTable = new Map<string, Column[]>();
    for (const c of columnsResult.rows) {
      const list = columnsByTable.get(c.table_name) ?? [];
      list.push({ name: c.column_name, dataType: c.data_type, udtName: c.udt_name, nullable: c.is_nullable === "YES", defaultValue: c.column_default, ordinal: c.ordinal_position, maxLength: c.character_maximum_length, numericPrecision: c.numeric_precision, numericScale: c.numeric_scale, datetimePrecision: c.datetime_precision });
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
      rowEstimate: Number(t.estimate)
    }));
    const fkGroups = new Map<string, ForeignKey>();
    for (const f of fkResult.rows) {
      const key = f.table_name + "." + f.constraint_name;
      const group = fkGroups.get(key) ?? {
        table: f.table_name, name: f.constraint_name, columns: [],
        referencedTable: f.foreign_table_name, referencedColumns: [],
        deferrable: f.is_deferrable === "YES"
      };
      group.columns.push(f.column_name);
      group.referencedColumns.push(f.foreign_column_name);
      fkGroups.set(key, group);
    }
    await client.query("COMMIT");
    return { tables, foreignKeys: [...fkGroups.values()], sequences: sequenceResult.rows, features: featureResult.rows[0] };
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
    .map(item => JSON.stringify([item.columns, item.referencedTable, item.referencedColumns, item.deferrable]))
    .sort();
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
      else if (c.udtName !== other.udtName || c.dataType !== other.dataType || c.maxLength !== other.maxLength || c.numericPrecision !== other.numericPrecision || c.numericScale !== other.numericScale || c.datetimePrecision !== other.datetimePrecision) differences.push("اختلاف نوع أو دقة العمود: " + c.name);
    }
    for (const c of to.columns) if (!sourceColumns.has(c.name) && !c.nullable && c.defaultValue === null) differences.push("عمود إلزامي إضافي بالوجهة: " + c.name);
    if (from.primaryKey.length === 0) differences.push("جدول المصدر بلا مفتاح أساسي؛ لا يمكن ضمان نقل آمن قابل للاستئناف");
    if (from.kind === "partitioned") differences.push("الجدول مقسّم إلى partitions؛ النقل الآلي متوقف لحين معالجة التقسيم صراحةً");
    if (JSON.stringify(from.primaryKey) !== JSON.stringify(to.primaryKey)) differences.push("اختلاف المفتاح الأساسي");
    if (JSON.stringify(fkSignature(legacy.foreignKeys, name)) !== JSON.stringify(fkSignature(target.foreignKeys, name))) differences.push("اختلاف علاقات المفاتيح الخارجية");
    if (from.kind !== to.kind) differences.push("اختلاف نوع الجدول");
    return { table: name, status: differences.length ? "schema_mismatch" : "compatible", sourceEstimate: from.rowEstimate, targetEstimate: to.rowEstimate, differences };
  });
  return {
    source: { tableCount: legacy.tables.length, estimatedRows: legacy.tables.reduce((n,t)=>n+t.rowEstimate,0), foreignKeyCount: legacy.foreignKeys.length },
    target: { tableCount: target.tables.length, estimatedRows: target.tables.reduce((n,t)=>n+t.rowEstimate,0), foreignKeyCount: target.foreignKeys.length },
    comparison,
    foreignKeys: legacy.foreignKeys,
    sourceFeatures: legacy.features,
    targetFeatures: target.features,
    sourceSequences: legacy.sequences,
    targetSequences: target.sequences,
    blockers: comparison.filter(x => x.status === "source_only" || x.status === "schema_mismatch").map(x => ({ table: x.table, status: x.status, differences: x.differences })),
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
