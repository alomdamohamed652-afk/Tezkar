import type pg from "pg";
import { createBackupArchive, createBackupArchiveStream, type BackupPayload, type BackupTable } from "./backup-archive.js";

const EXCLUDED_TABLES = new Set([
  "schema_migrations",
  "user_sessions",
  "password_reset_requests",
  "auth_login_attempts"
]);
const MAX_EXPORTED_ROWS = 2_000_000;
const MAX_ESTIMATED_PAYLOAD_BYTES = 64 * 1024 * 1024;
const EXPORT_BATCH_SIZE = 500;

type TableInfo = { table_name: string; primary_key_columns: string[] };
type ColumnInfo = { column_name: string; pg_type: string };
type SequenceInfo = { sequence_name: string };

async function listBackupTables(client: pg.PoolClient): Promise<TableInfo[]> {
  // A plain SELECT from an inheritance/partition parent can include descendant
  // rows while those descendants are also enumerated as separate relations.
  // Until the archive format models relation topology explicitly, fail closed
  // rather than silently duplicate rows or restore them to the wrong relation.
  const inheritance = await client.query<{ relation_name: string }>(`
    SELECT DISTINCT parent.relname AS relation_name
      FROM pg_inherits i
      JOIN pg_class parent ON parent.oid=i.inhparent
      JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      JOIN pg_class child ON child.oid=i.inhrelid
      JOIN pg_namespace cn ON cn.oid=child.relnamespace
     WHERE pn.nspname='public' OR cn.nspname='public'
     ORDER BY parent.relname
     LIMIT 1
  `);
  const inheritedRelation = inheritance.rows[0]?.relation_name;
  if (inheritedRelation) {
    throw new Error(`لا يمكن إنشاء نسخة آمنة حاليًا لوجود وراثة أو تقسيم جداول في public (الجدول: ${inheritedRelation})`);
  }
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

async function exportSequences(client: pg.PoolClient): Promise<NonNullable<BackupPayload["sequences"]>> {
  const listed = await client.query<{
    sequence_name: string; increment_by: string; min_value: string; max_value: string;
    start_value: string; cache_size: string; cycle: boolean;
  }>(`
    SELECT c.relname AS sequence_name,
           s.seqincrement::text AS increment_by,
           s.seqmin::text AS min_value,
           s.seqmax::text AS max_value,
           s.seqstart::text AS start_value,
           s.seqcache::text AS cache_size,
           s.seqcycle AS cycle
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_sequence s ON s.seqrelid=c.oid
     WHERE n.nspname='public' AND c.relkind='S'
     ORDER BY c.relname
  `);
  const sequences: NonNullable<BackupPayload["sequences"]> = [];
  for (const sequence of listed.rows) {
    const state = await client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM public.${quoteIdentifier(sequence.sequence_name)}`
    );
    if (!state.rows[0]) throw new Error(`تعذر قراءة حالة التسلسل ${sequence.sequence_name}`);
    sequences.push({
      name: sequence.sequence_name,
      lastValue: state.rows[0].last_value,
      isCalled: state.rows[0].is_called,
      incrementBy: sequence.increment_by,
      minValue: sequence.min_value,
      maxValue: sequence.max_value,
      startValue: sequence.start_value,
      cacheSize: sequence.cache_size,
      cycle: sequence.cycle
    });
  }
  return sequences;
}

export async function buildBackupPayload(pool: pg.Pool): Promise<BackupPayload> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await listBackupTables(client);
    const exported: BackupTable[] = [];
    let totalRows = 0;
    let estimatedPayloadBytes = 0;
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
      await client.query(
        `DECLARE backup_export_cursor NO SCROLL CURSOR FOR SELECT jsonb_build_object(${fields}) AS row_data FROM public.${quoteIdentifier(table.table_name)} t`
      );
      const rows: Record<string, string | null>[] = [];
      while (true) {
        const batch = await client.query<{ row_data: Record<string, string | null> }>(
          `FETCH FORWARD ${EXPORT_BATCH_SIZE} FROM backup_export_cursor`
        );
        if (!batch.rows.length) break;
        totalRows += batch.rows.length;
        if (totalRows > MAX_EXPORTED_ROWS) {
          await client.query("CLOSE backup_export_cursor");
          throw new Error("عدد السجلات أكبر من الحد المدعوم حاليًا؛ أوقف التصدير دون إنشاء نسخة ناقصة");
        }
        for (const item of batch.rows) {
          const rowBytes = Buffer.byteLength(JSON.stringify(item.row_data), "utf8") + 1;
          estimatedPayloadBytes += rowBytes;
          if (estimatedPayloadBytes > MAX_ESTIMATED_PAYLOAD_BYTES) {
            await client.query("CLOSE backup_export_cursor");
            throw new Error("حجم بيانات النسخة تجاوز الحد الآمن للتصدير؛ لم يتم إنشاء ملف ناقص");
          }
          rows.push(item.row_data);
        }
      }
      await client.query("CLOSE backup_export_cursor");
      exported.push({ name: table.table_name, primaryKey: table.primary_key_columns, columns: columns.map(column => ({ name: column.column_name, pgType: column.pg_type })), rows });
    }
    const sequences = await exportSequences(client);
    const version = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1"
    ).catch(() => ({ rows: [] as {version:string}[] }));
    await client.query("COMMIT");
    return {
      format: "tezkar-full-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      sourceSchemaVersion: version.rows[0]?.version ?? null,
      tables: exported,
      sequences
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


/**
 * Yield a consistent JSON snapshot a table/batch at a time. The cursor and
 * repeatable-read transaction stay open only while the HTTP stream is consumed;
 * destroying the response closes the cursor and rolls the read-only transaction back.
 */
async function* buildBackupJsonChunks(pool: pg.Pool): AsyncGenerator<string> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const tables = await listBackupTables(client);
    const createdAt = new Date().toISOString();
    const version = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1"
    ).catch(() => ({ rows: [] as { version: string }[] }));
    yield JSON.stringify({
      format: "tezkar-full-backup",
      version: 1,
      createdAt,
      sourceSchemaVersion: version.rows[0]?.version ?? null
    }).slice(0, -1) + ',"tables":[';

    let totalRows = 0;
    let estimatedPayloadBytes = 0;
    for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
      const table = tables[tableIndex]!;
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
      const tableHeader = {
        name: table.table_name,
        primaryKey: table.primary_key_columns,
        columns: columns.map(column => ({ name: column.column_name, pgType: column.pg_type }))
      };
      yield (tableIndex === 0 ? "" : ",") + JSON.stringify(tableHeader).slice(0, -1) + ',"rows":[';

      const fields = columns.flatMap(column => [
        quoteLiteral(column.column_name),
        `t.${quoteIdentifier(column.column_name)}::text`
      ]).join(",");
      await client.query(
        `DECLARE backup_export_cursor NO SCROLL CURSOR FOR SELECT jsonb_build_object(${fields}) AS row_data FROM public.${quoteIdentifier(table.table_name)} t`
      );
      let cursorOpen = true;
      let firstRow = true;
      try {
        while (true) {
          const batch = await client.query<{ row_data: Record<string, string | null> }>(
            `FETCH FORWARD ${EXPORT_BATCH_SIZE} FROM backup_export_cursor`
          );
          if (!batch.rows.length) break;
          totalRows += batch.rows.length;
          if (totalRows > MAX_EXPORTED_ROWS) {
            throw new Error("عدد السجلات أكبر من الحد المدعوم حاليًا؛ أوقف التصدير دون إنشاء نسخة ناقصة");
          }
          for (const item of batch.rows) {
            const serialized = JSON.stringify(item.row_data);
            estimatedPayloadBytes += Buffer.byteLength(serialized, "utf8") + 1;
            if (estimatedPayloadBytes > MAX_ESTIMATED_PAYLOAD_BYTES) {
              throw new Error("حجم بيانات النسخة تجاوز الحد الآمن للتصدير؛ لم يتم إنشاء ملف ناقص");
            }
            yield (firstRow ? "" : ",") + serialized;
            firstRow = false;
          }
        }
      } finally {
        if (cursorOpen) {
          await client.query("CLOSE backup_export_cursor").catch(() => undefined);
          cursorOpen = false;
        }
      }
      yield "]}";
    }
    const sequences = await exportSequences(client);
    yield '],"sequences":' + JSON.stringify(sequences) + "}";
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export function createDatabaseBackupStream(
  pool: pg.Pool,
  password: string,
  onComplete?: () => Promise<void>
) {
  return createBackupArchiveStream(buildBackupJsonChunks(pool), password, onComplete);
}
