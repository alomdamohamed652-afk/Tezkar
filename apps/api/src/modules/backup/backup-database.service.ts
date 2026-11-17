import type pg from "pg";
import { createHash } from "node:crypto";
import { createBackupArchive, type BackupPayload, type BackupTable } from "./backup-archive.js";

const EXCLUDED_TABLES = new Set([
  "schema_migrations",
  "user_sessions",
  "password_reset_requests"
]);
const MAX_EXPORTED_ROWS = 2_000_000;

type TableInfo = { table_name: string; primary_key_columns: string[] };

async function listBackupTables(client: pg.PoolClient): Promise<TableInfo[]> {
  const result = await client.query<{ table_name: string; primary_key_columns: string[] }>(`
    SELECT c.relname AS table_name,
           COALESCE(array_agg(a.attname ORDER BY k.ordinality)
             FILTER (WHERE a.attname IS NOT NULL), ARRAY[]::text[]) AS primary_key_columns
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) ON TRUE
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
     WHERE n.nspname='public' AND c.relkind IN ('r','p')
     GROUP BY c.relname
     ORDER BY c.relname
  `);
  return result.rows.filter(row => !EXCLUDED_TABLES.has(row.table_name));
}

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
      const result = await client.query<{ row_data: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS row_data FROM public.${quoteIdentifier(table.table_name)} t`
      );
      totalRows += result.rowCount ?? 0;
      if (totalRows > MAX_EXPORTED_ROWS) throw new Error("عدد السجلات أكبر من الحد المدعوم حاليًا؛ أوقف التصدير دون إنشاء نسخة ناقصة");
      exported.push({ name: table.table_name, rows: result.rows.map(row => row.row_data) });
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
  // Hash is returned in the archive manifest in a later format revision; for now,
  // GCM authentication protects the complete encrypted payload.
  createHash("sha256").update(archive).digest("hex");
  return archive;
}
