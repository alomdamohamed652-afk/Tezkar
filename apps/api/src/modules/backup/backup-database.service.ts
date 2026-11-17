import type pg from "pg";
import { createBackupArchive, type BackupPayload, type BackupTable } from "./backup-archive.js";

const EXCLUDED_TABLES = new Set([
  "schema_migrations",
  "user_sessions",
  "password_reset_requests"
]);
const MAX_EXPORTED_ROWS = 2_000_000;

type TableInfo = { table_name: string; primary_key_columns: string[] };
type ColumnInfo = { column_name: string; pg_type: string };

async function listBackupTables(client: pg.PoolClient): Promise<TableInfo[]> {
  const result = await client.query<{ table_name: string; primary_key_columns: string[] }>(`
    SELECT c.relname AS table_name,
           COALESCE(array_agg(a.attname ORDER BY k.ordinality)
             FILTER (WHERE a.attname IS NOT NULL), ARRAY[]::text[]) AS primary_key_columns
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary
      LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) ON TRUE
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
     WHERE n.nspname='public' AND c.relkind IN ('r','p')
     GROUP BY c.relname
     ORDER BY c.relname
  `);
  return result.rows.filter(row => !EXCLUDED_TABLES.has(row.table_name));
}

function quoteLiteral(value: string): string { return "'" + value.replace(/'/g, "''") + "'"; }

function quoteIdentifier(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

export async function buildBackupPayload(pool: pg.Pool): Promise<BackupPayload> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await listBackupTables(client);
    const exported: BackupTable[] = [];
    let totalRows = 0;
    for (const table of tables) {
      if (table.primary_key_columns.length === 0) {
        throw new Error(`لا يمكن أخذ نسخة آمنة: الجدول ${table.table_name} لا يحتوي مفتاحًا أساسيًا`);
      }
      const columnsResult = await client.query<ColumnInfo>(`
        SELECT a.attname AS column_name, format_type(a.atttypid,a.atttypmod) AS pg_type
          FROM pg_attribute a
          JOIN pg_class c ON c.oid=a.attrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped
         ORDER BY a.attnum
      `, [table.table_name]);
      const columns = columnsResult.rows;
      if (!columns.length) throw new Error(`لا يمكن قراءة أعمدة الجدول ${table.table_name}`);
      const fields = columns.flatMap(column => [quoteLiteral(column.column_name), `t.${quoteIdentifier(column.column_name)}::text`]).join(",");
      const result = await client.query<{ row_data: Record<string, string | null> }>(
        `SELECT jsonb_build_object(${fields}) AS row_data FROM public.${quoteIdentifier(table.table_name)} t`
      );
      totalRows += result.rowCount ?? 0;
      if (totalRows > MAX_EXPORTED_ROWS) throw new Error("عدد السجلات أكبر من الحد المدعوم حاليًا؛ أوقف التصدير دون إنشاء نسخة ناقصة");
      exported.push({ name: table.table_name, primaryKey: table.primary_key_columns, columns: columns.map(column => ({ name: column.column_name, pgType: column.pg_type })), rows: result.rows.map(row => row.row_data) });
    }
    const version = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1"
    ).catch(() => ({ rows: [] as {version:string}[] }));
    await client.query("COMMIT");
    return {
      format: "tezkar-full-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      sourceSchemaVersion: version.rows[0]?.version ?? null,
      tables: exported
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createDatabaseBackup(pool: pg.Pool, password: string): Promise<Buffer> {
  const payload = await buildBackupPayload(pool);
  const archive = await createBackupArchive(payload, password);
  return archive;
}
