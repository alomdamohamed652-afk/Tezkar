import pg from "pg";

const CONNECTION_TIMEOUT_MS = 5_000;
export const SOURCE_READ_ONLY_OPTIONS = "-c default_transaction_read_only=on";

/**
 * Source connections are forced read-only by PostgreSQL at session start.
 * Callers must still use read-only transactions and never elevate this session.
 */
export function createReadOnlySourcePool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 1_000,
    options: SOURCE_READ_ONLY_OPTIONS
  });
}

/** Verifies the server-enforced session setting before any source query is run. */
export async function assertReadOnlySourceSession(client: Pick<pg.PoolClient, "query">): Promise<void> {
  const result = await client.query("SHOW transaction_read_only");
  const value = String(result.rows[0]?.transaction_read_only ?? "").toLowerCase();
  if (value !== "on") {
    throw new Error("اتصال المصدر ليس للقراءة فقط؛ تم إيقاف العملية لحماية قاعدة البيانات القديمة.");
  }
}

/** Refuses ambiguous or identical source/target database identities before connecting. */
export function assertDistinctDatabaseIdentities(sourceIdentity: string | null, targetIdentity: string | null): void {
  if (!sourceIdentity || !targetIdentity || sourceIdentity === targetIdentity) {
    throw new Error("تعذر إثبات اختلاف قاعدة المصدر عن الوجهة أو التأكد من أنهما لا يشيران إلى نفس قاعدة البيانات؛ تم إيقاف العملية لحماية البيانات.");
  }
}

/** Target writes must use a separately-created pool after explicit authorization only. */
export function createTargetPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 1_000
  });
}

/**
 * Compares the actual PostgreSQL server endpoint after both connections are open.
 * This catches aliases that resolve to the same server/database even when URLs differ.
 */
export async function assertDistinctConnectedDatabases(
  source: Pick<pg.PoolClient, "query">,
  target: Pick<pg.PoolClient, "query">
): Promise<void> {
  const sql = `
    SELECT current_database() AS database_name,
           (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port
  `;
  const [sourceResult, targetResult] = await Promise.all([source.query(sql), target.query(sql)]);
  const identity = (row: Record<string, unknown>) => {
    const database = String(row.database_name ?? "");
    const oid = String(row.database_oid ?? "");
    const address = String(row.server_address ?? "");
    const port = String(row.server_port ?? "");
    if (!database || !oid || !address || !port) return null;
    return `${address}:${port}/${oid}/${database}`;
  };
  const sourceIdentity = identity(sourceResult.rows[0] ?? {});
  const targetIdentity = identity(targetResult.rows[0] ?? {});
  if (!sourceIdentity || !targetIdentity || sourceIdentity === targetIdentity) {
    throw new Error("تعذر إثبات اختلاف قاعدتي البيانات من خادم PostgreSQL نفسه؛ تم إيقاف الفحص لحماية المصدر.");
  }
}
