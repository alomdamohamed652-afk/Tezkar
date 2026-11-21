import pg from "pg";

type ColumnShape = { name: string; type: string; nullable: boolean; defaultValue: string | null };
type TableShape = {
  estimate: number;
  columns: ColumnShape[];
  primaryKey: string[];
  foreignKeys: string[];
};
type FeatureCounts = {
  views: number;
  materializedViews: number;
  triggers: number;
  extensions: number;
  largeObjects: number;
  customTypes: number;
  routines: number;
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
           WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
             AND n.nspname NOT LIKE 'pg_toast%'
           ORDER BY n.nspname,c.relname
    `);
    const columns = await client.query(`

          SELECT table_schema,table_name,column_name,
                 COALESCE(NULLIF(data_type,''),udt_name) AS type,
                 is_nullable='YES' AS nullable,column_default
            FROM information_schema.columns
           WHERE table_schema NOT IN ('pg_catalog','information_schema')
           ORDER BY table_schema,table_name,ordinal_position
    `);
    const primaryKeys = await client.query(`

          SELECT tc.table_schema,tc.table_name,kcu.column_name,kcu.ordinal_position
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_catalog=tc.constraint_catalog AND kcu.constraint_schema=tc.constraint_schema
             AND kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema AND kcu.table_name=tc.table_name
           WHERE tc.constraint_type='PRIMARY KEY'
           ORDER BY tc.table_schema,tc.table_name,kcu.ordinal_position
    `);
    const foreignKeys = await client.query(`

          SELECT n.nspname AS table_schema,t.relname AS table_name,
                 pg_get_constraintdef(con.oid,true) AS signature
            FROM pg_constraint con
            JOIN pg_class t ON t.oid=con.conrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
           WHERE con.contype='f' AND n.nspname NOT IN ('pg_catalog','information_schema')
           ORDER BY n.nspname,t.relname,pg_get_constraintdef(con.oid,true)
    `);
    const indexes = await client.query(`

          SELECT schemaname,tablename,
                 (CASE WHEN indexdef LIKE 'CREATE UNIQUE INDEX %' THEN 'UNIQUE' ELSE 'NONUNIQUE' END)
                 || substring(indexdef FROM ' USING .*$') AS definition
            FROM pg_indexes
           WHERE schemaname NOT IN ('pg_catalog','information_schema')
           ORDER BY schemaname,tablename,definition
    `);
    const constraints = await client.query(`

          SELECT n.nspname AS table_schema,t.relname AS table_name,con.contype AS constraint_type,
                 pg_get_constraintdef(con.oid,true) AS definition
            FROM pg_constraint con
            JOIN pg_class t ON t.oid=con.conrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
           WHERE con.contype IN ('u','c','x') AND n.nspname NOT IN ('pg_catalog','information_schema')
           ORDER BY n.nspname,t.relname,con.contype,pg_get_constraintdef(con.oid,true)
    `);
    const views = await client.query(`

          SELECT schemaname,viewname,definition FROM pg_views
           WHERE schemaname NOT IN ('pg_catalog','information_schema')
           ORDER BY schemaname,viewname
    `);
    const materializedViews = await client.query(`

          SELECT schemaname,matviewname,definition FROM pg_matviews
           WHERE schemaname NOT IN ('pg_catalog','information_schema')
           ORDER BY schemaname,matviewname
    `);
    const triggers = await client.query(`

          SELECT n.nspname AS schema_name,c.relname AS table_name,t.tgname AS trigger_name,
                 pg_get_triggerdef(t.oid,true) AS definition
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
           ORDER BY n.nspname,c.relname,t.tgname
    `);
    const features = await client.query(`

          SELECT
            (SELECT count(*) FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema'))::int AS views,
            (SELECT count(*) FROM pg_matviews WHERE schemaname NOT IN ('pg_catalog','information_schema'))::int AS materialized_views,
            (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
               JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema'))::int AS triggers,
            (SELECT count(*) FROM pg_extension)::int AS extensions,
            (SELECT count(*) FROM pg_largeobject_metadata)::int AS large_objects,
            (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
              WHERE t.typtype IN ('e','d','c') AND n.nspname NOT IN ('pg_catalog','information_schema'))::int AS custom_types,
            (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname NOT IN ('pg_catalog','information_schema'))::int AS routines
    `);

    const tableMap = new Map<string, TableShape>();
    for (const row of tables.rows) {
      tableMap.set(`${row.schema_name}.${row.table_name}`, {
        estimate: Number(row.estimated_rows) || 0, columns: [], primaryKey: [], foreignKeys: []
      });
    }
    for (const row of columns.rows) {
      tableMap.get(`${row.table_schema}.${row.table_name}`)?.columns.push({
        name: row.column_name, type: row.type, nullable: row.nullable, defaultValue: row.column_default
      });
    }
    for (const row of primaryKeys.rows) {
      tableMap.get(`${row.table_schema}.${row.table_name}`)?.primaryKey.push(row.column_name);
    }
    for (const row of foreignKeys.rows) {
      tableMap.get(`${row.table_schema}.${row.table_name}`)?.foreignKeys.push(row.signature);
    }

    const featureRow = features.rows[0] ?? {};
    const featureCounts: FeatureCounts = {
      views: Number(featureRow.views) || 0,
      materializedViews: Number(featureRow.materialized_views) || 0,
      triggers: Number(featureRow.triggers) || 0,
      extensions: Number(featureRow.extensions) || 0,
      largeObjects: Number(featureRow.large_objects) || 0,
      customTypes: Number(featureRow.custom_types) || 0,
      routines: Number(featureRow.routines) || 0
    };
    return {
      tables: tableMap,
      estimatedRows: [...tableMap.values()].reduce((sum, table) => sum + table.estimate, 0),
      foreignKeyCount: [...tableMap.values()].reduce((sum, table) => sum + table.foreignKeys.length, 0),
      indexes: indexes.rows.map((row: any) => `${row.schemaname}.${row.tablename}:${row.definition}`),
      constraints: constraints.rows.map((row: any) =>
        `${row.table_schema}.${row.table_name}:${row.constraint_type}:${row.definition ?? ""}`),
      views: views.rows.map((row: any) => `${row.schemaname}.${row.viewname}:${row.definition}`),
      materializedViews: materializedViews.rows.map((row: any) =>
        `${row.schemaname}.${row.matviewname}:${row.definition}`),
      triggers: triggers.rows.map((row: any) =>
        `${row.schema_name}.${row.table_name}.${row.trigger_name}:${row.definition}`),
      features: featureCounts
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
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
          `${column.name}:${column.type}:${column.nullable}:${column.defaultValue ?? ""}`).sort();
      if (JSON.stringify(columnSignature(left)) !== JSON.stringify(columnSignature(right))) {
        differences.push("اختلاف الأعمدة أو أنواعها أو خصائصها");
      }
      if (JSON.stringify(left.primaryKey) !== JSON.stringify(right.primaryKey)) {
        differences.push("اختلاف المفتاح الأساسي");
      }
      if (JSON.stringify([...left.foreignKeys].sort()) !== JSON.stringify([...right.foreignKeys].sort())) {
        differences.push("اختلاف المفاتيح الخارجية");
      }
    }
    const status = !left ? "target_only" : !right ? "source_only" :
      differences.length ? "schema_mismatch" : "compatible";
    return {
      table: name, status, sourceEstimate: left?.estimate ?? 0,
      targetEstimate: right?.estimate ?? 0, differences
    };
  });
}

export function databaseIdentity(connectionString: string): string | null {
  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || "5432";
    const database = decodeURIComponent(parsed.pathname.slice(1));
    return host && database ? `${host}:${port}/${database}` : null;
  } catch {
    return null;
  }
}

export async function inspectDatabaseTransfer(sourceUrl: string, targetUrl: string) {
  const sourceIdentity = databaseIdentity(sourceUrl);
  const targetIdentity = databaseIdentity(targetUrl);
  if (sourceUrl === targetUrl || (sourceIdentity && targetIdentity && sourceIdentity === targetIdentity)) {
    throw new Error("مصدر البيانات والوجهة يشيران إلى نفس قاعدة البيانات؛ أوقف الفحص لحماية البيانات.");
  }

  const sourcePool = new pg.Pool({
    connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000
  });
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
            differences: diff(source.triggers, target.triggers) }
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
