import pg from "pg";
import { createHash } from "node:crypto";
import { assertDistinctConnectedDatabases, assertDistinctDatabaseIdentities, assertReadOnlySourceSession, createReadOnlySourcePool } from "./data-transfer-connection.service.js";

type ColumnShape = {
  name: string; type: string; udtSchema: string; udtName: string;
  domainSchema: string | null; domainName: string | null;
  nullable: boolean; defaultValue: string | null; identity: string; generated: string;
  collation: string | null;
};
type TableShape = {
  estimate: number;
  columns: ColumnShape[];
  primaryKey: string[];
  foreignKeys: string[];
  dependencies: string[];
  indexes: string[];
  constraints: string[];
  triggers: string[];
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: string[];
};
type FeatureCounts = {
  views: number;
  materializedViews: number;
  triggers: number;
  extensions: number;
  largeObjects: number;
  customTypes: number;
  routines: number;
  sequences: number;
};
type DatabaseSnapshot = {
  tables: Map<string, TableShape>;
  estimatedRows: number;
  foreignKeyCount: number;
  indexes: string[];
  constraints: string[];
  views: string[];
  materializedViews: string[];
  triggers: string[];
  extensions: string[];
  customTypes: string[];
  routines: string[];
  sequences: string[];
  features: FeatureCounts;
};

async function readSnapshot(client: pg.PoolClient): Promise<DatabaseSnapshot> {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '15000'");
    const tables = await client.query(`

          SELECT n.nspname AS schema_name, c.relname AS table_name,
                 GREATEST(c.reltuples, 0)::bigint AS estimated_rows
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE c.relkind IN ('r','p') AND n.nspname = 'public'
             AND n.nspname NOT LIKE 'pg_toast%'
           ORDER BY n.nspname,c.relname
    `);
    const columns = await client.query(`

          SELECT table_schema,table_name,column_name,
                 COALESCE(NULLIF(data_type,''),udt_name) AS type,
                 udt_schema, udt_name, domain_schema, domain_name,
                 is_nullable='YES' AS nullable, column_default,
                 CASE WHEN is_identity='YES' THEN identity_generation ELSE '' END AS identity_generation,
                 is_generated, collation_schema || '.' || collation_name AS collation
            FROM information_schema.columns
           WHERE table_schema = 'public'
           ORDER BY table_schema,table_name,ordinal_position
    `);
    const primaryKeys = await client.query(`

          SELECT tc.table_schema,tc.table_name,kcu.column_name,kcu.ordinal_position
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_catalog=tc.constraint_catalog AND kcu.constraint_schema=tc.constraint_schema
             AND kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema AND kcu.table_name=tc.table_name
           WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema = 'public'
           ORDER BY tc.table_schema,tc.table_name,kcu.ordinal_position
    `);
    const foreignKeys = await client.query(`

          SELECT n.nspname AS table_schema,t.relname AS table_name,
                 pg_get_constraintdef(con.oid,true) AS signature,
                 rn.nspname AS referenced_schema, rt.relname AS referenced_table
            FROM pg_constraint con
            JOIN pg_class t ON t.oid=con.conrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
            JOIN pg_class rt ON rt.oid=con.confrelid
            JOIN pg_namespace rn ON rn.oid=rt.relnamespace
           WHERE con.contype='f' AND n.nspname = 'public'
           ORDER BY n.nspname,t.relname,pg_get_constraintdef(con.oid,true)
    `);
    const indexes = await client.query(`

          SELECT schemaname,tablename,
                 (CASE WHEN indexdef LIKE 'CREATE UNIQUE INDEX %' THEN 'UNIQUE' ELSE 'NONUNIQUE' END)
                 || substring(indexdef FROM ' USING .*$') AS definition
            FROM pg_indexes
           WHERE schemaname = 'public'
           ORDER BY schemaname,tablename,definition
    `);
    const constraints = await client.query(`

          SELECT n.nspname AS table_schema,t.relname AS table_name,con.contype AS constraint_type,
                 pg_get_constraintdef(con.oid,true) AS definition
            FROM pg_constraint con
            JOIN pg_class t ON t.oid=con.conrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
           WHERE con.contype IN ('u','c','x') AND n.nspname = 'public'
           ORDER BY n.nspname,t.relname,con.contype,pg_get_constraintdef(con.oid,true)
    `);
    const views = await client.query(`

          SELECT schemaname,viewname,definition FROM pg_views
           WHERE schemaname = 'public'
           ORDER BY schemaname,viewname
    `);
    const materializedViews = await client.query(`

          SELECT schemaname,matviewname,definition FROM pg_matviews
           WHERE schemaname = 'public'
           ORDER BY schemaname,matviewname
    `);
    const rowSecurity = await client.query(`
          SELECT n.nspname AS schema_name, c.relname AS table_name,
                 c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','p') AND n.nspname = 'public'
           ORDER BY n.nspname, c.relname
    `);
    const policies = await client.query(`
          SELECT schemaname, tablename, policyname, permissive,
                 array_to_string(roles, ',') AS roles, cmd, qual, with_check
            FROM pg_policies
           WHERE schemaname = 'public'
           ORDER BY schemaname, tablename, policyname
    `);
    const triggers = await client.query(`

          SELECT n.nspname AS schema_name,c.relname AS table_name,t.tgname AS trigger_name,
                 pg_get_triggerdef(t.oid,true) AS definition
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE NOT t.tgisinternal AND n.nspname = 'public'
           ORDER BY n.nspname,c.relname,t.tgname
    `);
    const extensions = await client.query(`
          SELECT e.extname, e.extversion, n.nspname AS schema_name
            FROM pg_extension e
            JOIN pg_namespace n ON n.oid = e.extnamespace
           ORDER BY e.extname, n.nspname
    `);
    const customTypes = await client.query(`
          SELECT n.nspname AS schema_name, t.typname, t.typtype,
                 CASE WHEN t.typtype = 'e' THEN (
                   SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                     FROM pg_enum e WHERE e.enumtypid = t.oid
                 ) ELSE NULL END AS enum_values,
                 CASE WHEN t.typtype = 'd' THEN pg_get_constraintdef(c.oid, true) ELSE NULL END AS domain_constraints,
                 CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) ELSE NULL END AS domain_base,
                 CASE WHEN t.typtype = 'c' THEN (
                   SELECT string_agg(
                     format('%s:%s:%s:%s', a.attname, format_type(a.atttypid, a.atttypmod),
                       a.attnotnull, COALESCE(coll.collname, '')),
                     ',' ORDER BY a.attnum
                   )
                     FROM pg_attribute a
                     LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
                    WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
                 ) ELSE NULL END AS composite_attributes
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            LEFT JOIN pg_constraint c ON c.contypid = t.oid
           WHERE t.typtype IN ('e','d','c') AND n.nspname = 'public'
             AND (t.typtype <> 'c' OR NOT EXISTS (
               SELECT 1 FROM pg_class row_type
                WHERE row_type.reltype = t.oid AND row_type.relkind <> 'c'
             ))
           ORDER BY n.nspname, t.typname, c.conname
    `);
    const sequences = await client.query(`
          SELECT n.nspname AS schema_name, c.relname AS sequence_name,
                 format_type(s.seqtypid, NULL) AS data_type,
                 s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle,
                 COALESCE(refn.nspname || '.' || tbl.relname || '.' || att.attname, '') AS owned_by
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_sequence s ON s.seqrelid = c.oid
            LEFT JOIN pg_depend d
              ON d.classid = 'pg_class'::regclass AND d.objid = c.oid
             AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')
            LEFT JOIN pg_class tbl ON tbl.oid = d.refobjid
            LEFT JOIN pg_namespace refn ON refn.oid = tbl.relnamespace
            LEFT JOIN pg_attribute att ON att.attrelid = d.refobjid AND att.attnum = d.refobjsubid
           WHERE c.relkind = 'S' AND n.nspname = 'public'
           ORDER BY n.nspname, c.relname
    `);
    const routines = await client.query(`
          SELECT n.nspname AS schema_name, p.proname,
                 pg_get_function_identity_arguments(p.oid) AS identity_arguments,
                 pg_get_function_result(p.oid) AS result_type,
                 p.prokind, pg_get_functiondef(p.oid) AS definition
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind IN ('f','p','w')
           ORDER BY n.nspname, p.proname, identity_arguments
    `);
    const features = await client.query(`

          SELECT
            (SELECT count(*) FROM pg_views WHERE schemaname = 'public')::int AS views,
            (SELECT count(*) FROM pg_matviews WHERE schemaname = 'public')::int AS materialized_views,
            (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
               JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE NOT t.tgisinternal AND n.nspname = 'public')::int AS triggers,
            (SELECT count(*) FROM pg_extension)::int AS extensions,
            (SELECT count(*) FROM pg_largeobject_metadata)::int AS large_objects,
            (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
              WHERE t.typtype IN ('e','d','c') AND n.nspname = 'public'\n                AND (t.typtype <> 'c' OR NOT EXISTS (SELECT 1 FROM pg_class row_type\n                  WHERE row_type.reltype = t.oid AND row_type.relkind <> 'c')))::int AS custom_types,
            (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname = 'public' AND p.prokind IN ('f','p','w'))::int AS routines,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE c.relkind='S' AND n.nspname='public')::int AS sequences
    `);

    const tableMap = new Map<string, TableShape>();
    for (const row of tables.rows) {
      tableMap.set(`${row.schema_name}.${row.table_name}`, {
        estimate: Number(row.estimated_rows) || 0, columns: [], primaryKey: [], foreignKeys: [], dependencies: [], indexes: [], constraints: [], triggers: [],
        rlsEnabled: false, rlsForced: false, policies: []
      });
    }
    for (const row of columns.rows) {
      tableMap.get(`${row.table_schema}.${row.table_name}`)?.columns.push({
        name: row.column_name, type: row.type, udtSchema: row.udt_schema, udtName: row.udt_name,
        domainSchema: row.domain_schema, domainName: row.domain_name,
        nullable: row.nullable, defaultValue: row.column_default,
        identity: row.identity_generation ?? "", generated: row.is_generated ?? "",
        collation: row.collation ?? null
      });
    }
    for (const row of primaryKeys.rows) {
      tableMap.get(`${row.table_schema}.${row.table_name}`)?.primaryKey.push(row.column_name);
    }
    for (const row of foreignKeys.rows) {
      const table = tableMap.get(`${row.table_schema}.${row.table_name}`);
      table?.foreignKeys.push(row.signature);
      table?.dependencies.push(`${row.referenced_schema}.${row.referenced_table}`);
    }
    for (const row of indexes.rows) {
      tableMap.get(`${row.schemaname}.${row.tablename}`)?.indexes.push(row.definition);
    }
    for (const row of constraints.rows) {
      tableMap.get(`${row.table_schema}.${row.table_name}`)?.constraints.push(`${row.constraint_type}:${row.definition ?? ""}`);
    }
    for (const row of triggers.rows) {
      tableMap.get(`${row.schema_name}.${row.table_name}`)?.triggers.push(`${row.trigger_name}:${row.definition}`);
    }
    for (const row of rowSecurity.rows) {
      const table = tableMap.get(`${row.schema_name}.${row.table_name}`);
      if (table) {
        table.rlsEnabled = Boolean(row.rls_enabled);
        table.rlsForced = Boolean(row.rls_forced);
      }
    }
    for (const row of policies.rows) {
      tableMap.get(`${row.schemaname}.${row.tablename}`)?.policies.push(
        `${row.policyname}:${row.permissive}:${row.roles}:${row.cmd}:${row.qual ?? ""}:${row.with_check ?? ""}`
      );
    }

    const featureRow = features.rows[0] ?? {};
    const featureCounts: FeatureCounts = {
      views: Number(featureRow.views) || 0,
      materializedViews: Number(featureRow.materialized_views) || 0,
      triggers: Number(featureRow.triggers) || 0,
      extensions: Number(featureRow.extensions) || 0,
      largeObjects: Number(featureRow.large_objects) || 0,
      customTypes: Number(featureRow.custom_types) || 0,
      routines: Number(featureRow.routines) || 0,
      sequences: Number(featureRow.sequences) || 0
    };
    return {
      tables: tableMap,
      estimatedRows: [...tableMap.values()].reduce((sum, table) => sum + table.estimate, 0),
      foreignKeyCount: [...tableMap.values()].reduce((sum, table) => sum + table.foreignKeys.length, 0),
      indexes: indexes.rows.map((row: any) => `${row.schemaname}.${row.tablename}:${row.definition}`),
      constraints: constraints.rows.map((row: any) =>
        `${row.table_schema}.${row.table_name}:${row.constraint_type}:${row.definition ?? ""}`),
      views: views.rows.map((row: any) => `${row.schemaname}.${row.viewname}:${fingerprint(row.definition)}`),
      materializedViews: materializedViews.rows.map((row: any) =>
        `${row.schemaname}.${row.matviewname}:${fingerprint(row.definition)}`),
      triggers: triggers.rows.map((row: any) =>
        `${row.schema_name}.${row.table_name}.${row.trigger_name}:${fingerprint(row.definition)}`),
      extensions: extensions.rows.map((row: any) =>
        `${row.extname}:${row.extversion}:${row.schema_name}`),
      customTypes: customTypes.rows.map((row: any) =>
        `${row.schema_name}.${row.typname}:${row.typtype}:${row.domain_base ?? ""}:${row.enum_values ?? ""}:${row.domain_constraints ?? ""}:${row.composite_attributes ?? ""}`),
      routines: routines.rows.map((row: any) =>
        `${row.schema_name}.${row.proname}(${row.identity_arguments}):${row.result_type}:${row.prokind}:${fingerprint(row.definition)}`),
      sequences: sequences.rows.map((row: any) =>
        `${row.schema_name}.${row.sequence_name}:${row.data_type}:${row.seqstart}:${row.seqincrement}:${row.seqmin}:${row.seqmax}:${row.seqcache}:${row.seqcycle}:${row.owned_by}`),
      features: featureCounts
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function diff(source: string[], target: string[]) {
  const targetSet = new Set(target);
  const sourceSet = new Set(source);
  return {
    missingInTarget: source.filter(value => !targetSet.has(value)),
    missingInSource: target.filter(value => !sourceSet.has(value))
  };
}

function compareSnapshots(source: DatabaseSnapshot, target: DatabaseSnapshot) {
  const names = [...new Set([...source.tables.keys(), ...target.tables.keys()])].sort();
  return names.map(name => {
    const left = source.tables.get(name);
    const right = target.tables.get(name);
    const differences: string[] = [];
    if (!left) differences.push("الجدول غير موجود في المصدر");
    if (!right) differences.push("الجدول غير موجود في الوجهة");
    if (left && right) {
      const columnSignature = (table: TableShape) =>
        table.columns.map(column =>
          `${column.name}:${column.type}:${column.udtSchema}.${column.udtName}:${column.domainSchema ?? ""}.${column.domainName ?? ""}:${column.nullable}:${column.defaultValue ?? ""}:${column.identity}:${column.generated}:${column.collation ?? ""}`).sort();
      if (JSON.stringify(columnSignature(left)) !== JSON.stringify(columnSignature(right))) {
        differences.push("اختلاف الأعمدة أو أنواعها أو خصائصها");
      }
      if (left.primaryKey.length === 0 || right.primaryKey.length === 0) {
        differences.push("غياب المفتاح الأساسي؛ لا يمكن ضمان استئناف النقل ومنع التكرار بأمان");
      } else if (JSON.stringify(left.primaryKey) !== JSON.stringify(right.primaryKey)) {
        differences.push("اختلاف المفتاح الأساسي");
      }
      if (JSON.stringify([...left.foreignKeys].sort()) !== JSON.stringify([...right.foreignKeys].sort())) {
        differences.push("اختلاف المفاتيح الخارجية");
      }
      if (JSON.stringify([...left.indexes].sort()) !== JSON.stringify([...right.indexes].sort())) {
        differences.push("اختلاف الفهارس");
      }
      if (JSON.stringify([...left.constraints].sort()) !== JSON.stringify([...right.constraints].sort())) {
        differences.push("اختلاف قيود UNIQUE أو CHECK");
      }
      if (JSON.stringify([...left.triggers].sort()) !== JSON.stringify([...right.triggers].sort())) {
        differences.push("اختلاف المشغلات؛ قد تؤثر على البيانات عند الإدخال");
      }
      if (left.rlsEnabled !== right.rlsEnabled || left.rlsForced !== right.rlsForced ||
          JSON.stringify([...left.policies].sort()) !== JSON.stringify([...right.policies].sort())) {
        differences.push("اختلاف إعدادات RLS أو سياسات الوصول؛ قد يتغير سلوك القراءة والكتابة");
      }
    }
    const status = !left ? "target_only" : !right ? "source_only" :
      differences.length ? "schema_mismatch" : "compatible";
    return {
      table: name, status, sourceEstimate: left?.estimate ?? 0,
      targetEstimate: right?.estimate ?? 0, dependencies: left?.dependencies ?? [],
      hasPrimaryKey: Boolean(left?.primaryKey.length && right?.primaryKey.length), differences
    };
  });
}

export function databaseIdentity(connectionString: string): string | null {
  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || "5432";
    const database = decodeURIComponent(parsed.pathname.slice(1));
    // Normalize direct and pooled Supabase endpoints to the same project identity.
    const directSupabase = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    const isSupabasePooler = host.endsWith(".pooler.supabase.com");
    const poolerUser = isSupabasePooler ? decodeURIComponent(parsed.username).toLowerCase() : "";
    const pooledSupabase = poolerUser.match(/^postgres\.([a-z0-9_-]+)$/);
    const supabaseProjectRef = directSupabase?.[1] ?? pooledSupabase?.[1];
    if (supabaseProjectRef && database) return `supabase:${supabaseProjectRef}/${database}`;
    return host && database ? `${host}:${port}/${database}` : null;
  } catch {
    return null;
  }
}

export async function inspectDatabaseTransfer(sourceUrl: string, targetUrl: string) {
  const sourceIdentity = databaseIdentity(sourceUrl);
  const targetIdentity = databaseIdentity(targetUrl);
  assertDistinctDatabaseIdentities(sourceIdentity, targetIdentity);

  const sourcePool = createReadOnlySourcePool(sourceUrl);
  const targetPool = new pg.Pool({
    connectionString: targetUrl, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000
  });

  try {
    const sourceClient = await sourcePool.connect();
    let targetClient: pg.PoolClient;
    try {
      targetClient = await targetPool.connect();
    } catch (error) {
      sourceClient.release();
      throw error;
    }
    try {
      await assertReadOnlySourceSession(sourceClient);
      await assertDistinctConnectedDatabases(sourceClient, targetClient);
      const [source, target] = await Promise.all([
        readSnapshot(sourceClient), readSnapshot(targetClient)
      ]);
      const comparison = compareSnapshots(source, target);
      return {
        source: {
          tableCount: source.tables.size, estimatedRows: source.estimatedRows,
          foreignKeyCount: source.foreignKeyCount
        },
        target: {
          tableCount: target.tables.size, estimatedRows: target.estimatedRows,
          foreignKeyCount: target.foreignKeyCount
        },
        comparison,
        blockers: comparison.filter(row => row.status !== "compatible"),
        objectComparison: {
          indexes: { source: source.indexes.length, target: target.indexes.length,
            differences: diff(source.indexes, target.indexes) },
          constraints: { source: source.constraints.length, target: target.constraints.length,
            differences: diff(source.constraints, target.constraints) },
          views: { source: source.views.length, target: target.views.length,
            differences: diff(source.views, target.views) },
          materializedViews: { source: source.materializedViews.length, target: target.materializedViews.length,
            differences: diff(source.materializedViews, target.materializedViews) },
          triggers: { source: source.triggers.length, target: target.triggers.length,
            differences: diff(source.triggers, target.triggers) },
          extensions: { source: source.extensions.length, target: target.extensions.length,
            differences: diff(source.extensions, target.extensions) },
          customTypes: { source: source.customTypes.length, target: target.customTypes.length,
            differences: diff(source.customTypes, target.customTypes) },
          routines: { source: source.routines.length, target: target.routines.length,
            differences: diff(source.routines, target.routines) },
          sequences: { source: source.sequences.length, target: target.sequences.length,
            differences: diff(source.sequences, target.sequences) }
        },
        sourceFeatures: source.features,
        targetFeatures: target.features,
        note: "الفحص للقراءة فقط ويعرض تقديرات PostgreSQL. لا ينفذ نسخًا أو تعديلًا أو حذفًا أو ترحيلًا لأي بيانات أو مخطط."
      };
    } finally {
      sourceClient.release();
      targetClient.release();
    }
  } finally {
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}
