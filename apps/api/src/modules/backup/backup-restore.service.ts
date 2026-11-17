import type pg from "pg";
import type { BackupPayload, BackupTable } from "./backup-archive.js";

type CatalogTable = {
  name: string;
  columns: { name: string; type: string; notNull: boolean; hasDefault: boolean }[];
  primaryKey: string[];
};
type ForeignKey = { table_name: string; referenced_table: string; is_deferrable: boolean };

const EXCLUDED_TABLES = new Set([
  "schema_migrations",
  "user_sessions",
  "password_reset_requests",
  "auth_login_attempts"
]);

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function orderTables(names: string[], foreignKeys: ForeignKey[]): string[] {
  const included = new Set(names);
  const outgoing = new Map(names.map(name => [name, new Set<string>()]));
  const indegree = new Map(names.map(name => [name, 0]));
  for (const fk of foreignKeys) {
    if (!included.has(fk.table_name) || !included.has(fk.referenced_table)) continue;
    if (fk.table_name === fk.referenced_table) continue;
    const children = outgoing.get(fk.referenced_table)!;
    if (!children.has(fk.table_name)) {
      children.add(fk.table_name);
      indegree.set(fk.table_name, indegree.get(fk.table_name)! + 1);
    }
  }
  const ready = names.filter(name => indegree.get(name) === 0).sort();
  const ordered: string[] = [];
  while (ready.length) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const child of outgoing.get(current)!) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (ordered.length !== names.length) {
    throw new Error("توجد علاقات دائرية بين الجداول؛ تم إيقاف الاسترداد الآمن دون تعديل البيانات");
  }
  return ordered;
}

async function readCatalog(client: pg.PoolClient): Promise<{
  tables: Map<string, CatalogTable>;
  foreignKeys: ForeignKey[];
}> {
  const columns = await client.query<{
    table_name: string; column_name: string; pg_type: string; not_null: boolean; has_default: boolean;
  }>(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid,a.atttypmod) AS pg_type,
           a.attnotnull AS not_null, (d.adbin IS NOT NULL) AS has_default
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
     WHERE n.nspname='public' AND c.relkind IN ('r','p')
       AND a.attnum>0 AND NOT a.attisdropped
     ORDER BY c.relname,a.attnum
  `);
  const keys = await client.query<{ table_name: string; column_name: string; position: number }>(`
    SELECT c.relname AS table_name, a.attname AS column_name, k.ordinality AS position
      FROM pg_index i
      JOIN pg_class c ON c.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) ON TRUE
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
     WHERE n.nspname='public' AND i.indisprimary
     ORDER BY c.relname,k.ordinality
  `);
  const fkResult = await client.query<ForeignKey & { is_deferrable: boolean }>(`
    SELECT src.relname AS table_name, dst.relname AS referenced_table,
           con.condeferrable AS is_deferrable
      FROM pg_constraint con
      JOIN pg_class src ON src.oid=con.conrelid
      JOIN pg_namespace ns ON ns.oid=src.relnamespace
      JOIN pg_class dst ON dst.oid=con.confrelid
     WHERE con.contype='f' AND ns.nspname='public'
  `);
  const tables = new Map<string, CatalogTable>();
  for (const row of columns.rows) {
    let table = tables.get(row.table_name);
    if (!table) {
      table = { name: row.table_name, columns: [], primaryKey: [] };
      tables.set(row.table_name, table);
    }
    table.columns.push({ name: row.column_name, type: row.pg_type, notNull: row.not_null, hasDefault: row.has_default });
  }
  for (const row of keys.rows) tables.get(row.table_name)?.primaryKey.push(row.column_name);
  return { tables, foreignKeys: fkResult.rows };
}

function validateArchiveTable(source: BackupTable, target: CatalogTable): void {
  if (EXCLUDED_TABLES.has(source.name)) throw new Error(`النسخة تحتوي جدولًا مستثنى: ${source.name}`);
  const sourcePk = JSON.stringify(source.primaryKey);
  if (sourcePk !== JSON.stringify(target.primaryKey)) {
    throw new Error(`المفتاح الأساسي غير متوافق في الجدول ${source.name}`);
  }
  const targetColumns = new Map(target.columns.map(column => [column.name, column]));
  if (!Array.isArray(source.columns) || !Array.isArray(source.rows)) {
    throw new Error(`بنية الجدول غير صالحة: ${source.name}`);
  }
  for (const column of source.columns) {
    const actual = targetColumns.get(column.name);
    if (!actual || actual.type !== column.pgType) {
      throw new Error(`العمود أو نوعه غير متوافق: ${source.name}.${column.name}`);
    }
  }
  const sourceNames = new Set(source.columns.map(column => column.name));
  for (const column of target.columns) {
    if (column.notNull && !column.hasDefault && !sourceNames.has(column.name)) {
      throw new Error(`النسخة لا تحتوي العمود الإلزامي: ${source.name}.${column.name}`);
    }
  }
  for (const row of source.rows) {
    if (!row || typeof row !== "object" || Object.keys(row).length !== source.columns.length) {
      throw new Error(`سجل غير صالح في الجدول ${source.name}`);
    }
    for (const column of source.columns) {
      const value = row[column.name];
      if (value !== null && typeof value !== "string") {
        throw new Error(`قيمة غير صالحة في ${source.name}.${column.name}`);
      }
    }
  }
}

async function rowByPrimaryKey(
  client: pg.PoolClient,
  table: CatalogTable,
  source: BackupTable,
  row: Record<string, string | null>
): Promise<Record<string, string | null> | null> {
  const where = source.primaryKey.map((column, index) =>
    `${quoteIdentifier(column)} IS NOT DISTINCT FROM $${index + 1}`
  ).join(" AND ");
  const values = source.primaryKey.map(column => row[column]);
  const selected = source.columns.map(column =>
    `${quoteIdentifier(column.name)}::text AS ${quoteIdentifier(column.name)}`
  ).join(",");
  const result = await client.query(
    `SELECT ${selected} FROM public.${quoteIdentifier(table.name)} WHERE ${where} LIMIT 1`,
    values
  );
  return (result.rows[0] as Record<string, string | null> | undefined) ?? null;
}

function sameRow(a: Record<string, string | null>, b: Record<string, string | null>, columns: BackupTable["columns"]): boolean {
  return columns.every(column => a[column.name] === b[column.name]);
}

export type RestoreReport = {
  added: number;
  exactDuplicates: number;
  conflicts: { table: string; reason: string }[];
};

export async function restoreBackupIntoCurrentDatabase(
  pool: pg.Pool,
  payload: BackupPayload
): Promise<RestoreReport> {
  if (payload.format !== "tezkar-full-backup" || payload.version !== 1 || !Array.isArray(payload.tables)) {
    throw new Error("صيغة النسخة غير مدعومة");
  }
  const client = await pool.connect();
  const report: RestoreReport = { added: 0, exactDuplicates: 0, conflicts: [] };
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const catalog = await readCatalog(client);
    const sourceNames = payload.tables.map(table => table.name);
    if (new Set(sourceNames).size !== sourceNames.length) throw new Error("النسخة تحتوي أسماء جداول مكررة");
    for (const source of payload.tables) {
      const target = catalog.tables.get(source.name);
      if (!target) throw new Error(`الجدول غير موجود في قاعدة البيانات الحالية: ${source.name}`);
      validateArchiveTable(source, target);
    }
    const orderedNames = orderTables(sourceNames, catalog.foreignKeys);
    const sourceByName = new Map(payload.tables.map(table => [table.name, table]));
    for (const tableName of orderedNames) {
      const source = sourceByName.get(tableName)!;
      const target = catalog.tables.get(tableName)!;
      const columns = source.columns.map(column => quoteIdentifier(column.name)).join(",");
      const placeholders = source.columns.map((_, index) => `$${index + 1}`).join(",");
      for (const row of source.rows) {
        const existing = await rowByPrimaryKey(client, target, source, row);
        if (existing) {
          if (sameRow(existing, row, source.columns)) report.exactDuplicates += 1;
          else report.conflicts.push({ table: tableName, reason: "المفتاح الأساسي موجود لكن محتوى السجل مختلف" });
          continue;
        }
        const values = source.columns.map(column => row[column.name]);
        try {
          await client.query(
            `INSERT INTO public.${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
            values
          );
          report.added += 1;
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: string }).code : undefined;
          if (code === "23505" || code === "23503" || code === "23502" || code === "22P02" || code === "22007" || code === "22008") {
            report.conflicts.push({ table: tableName, reason: "تعارض قيد فريد أو علاقة أو قيمة غير متوافقة" });
            continue;
          }
          throw error;
        }
      }
    }
    if (report.conflicts.length) {
      await client.query("ROLLBACK");
      report.added = 0;
      return report;
    }
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
