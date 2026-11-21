import pg from "pg";
import { databaseIdentity } from "./data-transfer-inspection.service.js";
import { assertDistinctDatabaseIdentities, assertReadOnlySourceSession } from "./data-transfer-connection.service.js";

const MAX_TABLES = 5;
const STATEMENT_TIMEOUT_MS = 1500;
const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/;

export type RequestedTable = { schema: string; table: string; key: string };

export function parseRequestedTables(value: unknown): RequestedTable[] {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("حدد أسماء الجداول المطلوب فحصها.");
  }
  // Preserve empty segments so malformed input such as "a,,b" or "a," is rejected.
  const names = value.split(",").map(item => item.trim());
  if (names.length === 0 || names.length > MAX_TABLES) {
    throw new Error(`يسمح بفحص من 1 إلى ${MAX_TABLES} جداول في الطلب الواحد.`);
  }
  const unique = [...new Set(names)];
  if (unique.some(name => !name) || unique.length !== names.length || unique.some(name => !TABLE_NAME_PATTERN.test(name))) {
    throw new Error("صيغة أسماء الجداول غير صحيحة. استخدم schema.table.");
  }
  return unique.map(key => {
    const separator = key.indexOf(".");
    const schema = key.slice(0, separator);
    if (schema !== "public") throw new Error("يسمح بفحص جداول مخطط public فقط.");
    const table = key.slice(separator + 1);
    return { schema, table, key };
  });
}

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

export async function countRequestedTable(
  client: Pick<pg.PoolClient, "query">,
  item: RequestedTable
): Promise<{ table: string; status: "counted" | "missing" | "timeout" | "unavailable"; exactRows: string | null }> {
  let transactionOpen = false;
  try {
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    // Fail closed if this connection is subject to RLS; never report a policy-filtered partial count as exact.
    await client.query("SET LOCAL row_security = off");
    const exists = await client.query(
      `SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')
        LIMIT 1`,
      [item.schema, item.table]
    );
    if (exists.rowCount === 0) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { table: item.key, status: "missing", exactRows: null };
    }
    const count = await client.query(
      `SELECT count(*)::text AS exact_rows FROM ${quoteIdentifier(item.schema)}.${quoteIdentifier(item.table)}`
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return { table: item.key, status: "counted", exactRows: count.rows[0]?.exact_rows ?? "0" };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    return {
      table: item.key,
      status: code === "57014" ? "timeout" : "unavailable",
      exactRows: null
    };
  }
}

async function countOnDatabase(connectionString: string, tables: RequestedTable[], enforceSourceReadOnly = false) {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    ...(enforceSourceReadOnly ? { options: "-c default_transaction_read_only=on" } : {})
  });

  try {
    const client = await pool.connect();
    try {
      if (enforceSourceReadOnly) await assertReadOnlySourceSession(client);
      const results = [];
      for (const item of tables) {
        results.push(await countRequestedTable(client, item));
      }
      return results;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function inspectSelectedTableCounts(
  sourceUrl: string,
  targetUrl: string,
  tables: RequestedTable[]
) {
  if (tables.length < 1 || tables.length > MAX_TABLES) {
    throw new Error(`يسمح بفحص من 1 إلى ${MAX_TABLES} جداول في الطلب الواحد.`);
  }
  const sourceIdentity = databaseIdentity(sourceUrl);
  const targetIdentity = databaseIdentity(targetUrl);
  assertDistinctDatabaseIdentities(sourceIdentity, targetIdentity);
  const [source, target] = await Promise.all([
    countOnDatabase(sourceUrl, tables, true),
    countOnDatabase(targetUrl, tables)
  ]);
  return {
    limit: { maxTablesPerRequest: MAX_TABLES, statementTimeoutMs: STATEMENT_TIMEOUT_MS },
    source,
    target,
    note: "أعداد فعلية للجداول المحددة فقط. كل استعلام داخل معاملة قراءة فقط وبمهلة مستقلة؛ الجداول التي تتجاوز المهلة لا تُستكمل."
  };
}
