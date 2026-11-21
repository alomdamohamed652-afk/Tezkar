import pg from "pg";
import { databaseIdentity } from "./data-transfer-inspection.service.js";

const CONNECTION_TIMEOUT_MS = 5_000;

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
    options: "-c default_transaction_read_only=on"
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
export function assertDistinctDatabases(sourceUrl: string, targetUrl: string): void {
  const sourceIdentity = databaseIdentity(sourceUrl);
  const targetIdentity = databaseIdentity(targetUrl);
  if (!sourceIdentity || !targetIdentity || sourceUrl === targetUrl || sourceIdentity === targetIdentity) {
    throw new Error("تعذر إثبات اختلاف قاعدة المصدر عن الوجهة؛ تم إيقاف العملية لحماية البيانات.");
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
