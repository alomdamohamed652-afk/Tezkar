import { pool } from "../../db/pool.js";

type HealthDb = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

// In-memory ring buffer of recent 5xx errors, fed by the global error handler.
// No table needed: the buffer is per-process and resets on deploy, which is
// fine for a "is the system healthy right now" view.
export type RecentError = {
  at: string;
  route: string;
  method: string;
  message: string;
};

const MAX_RECENT_ERRORS = 50;
const recentErrors: RecentError[] = [];

export function recordServerError(input: { route: string; method: string; message: string }): void {
  recentErrors.unshift({
    at: new Date().toISOString(),
    route: input.route,
    method: input.method,
    message: input.message.slice(0, 300)
  });
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.length = MAX_RECENT_ERRORS;
}

export async function getAdminHealth(db: HealthDb = pool) {
  const startedAt = process.hrtime.bigint();
  let database: "ok" | "down" = "ok";
  let databaseLatencyMs: number | null = null;
  try {
    await db.query("SELECT 1 AS ok");
    databaseLatencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  } catch {
    database = "down";
  }

  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const lastMigration = await safe(async () => {
    const result = await db.query(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1"
    );
    return result.rows[0]
      ? { version: String(result.rows[0].version), appliedAt: result.rows[0].applied_at }
      : null;
  }, null);

  const migrationCount = await safe(async () => {
    const result = await db.query("SELECT count(*)::int AS n FROM schema_migrations");
    return Number(result.rows[0]?.n ?? 0);
  }, 0);

  const lastBackup = await safe(async () => {
    const result = await db.query(
      `SELECT occurred_at FROM audit_log
       WHERE module = 'system' AND entity_type = 'system_backup' AND action = 'export'
       ORDER BY occurred_at DESC LIMIT 1`
    );
    return result.rows[0] ? result.rows[0].occurred_at : null;
  }, null);

  const failedLogins24h = await safe(async () => {
    const result = await db.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE module = 'auth' AND action = 'login_failed' AND occurred_at > now() - interval '24 hours'`
    );
    return Number(result.rows[0]?.n ?? 0);
  }, 0);

  const recentFailedLogins = await safe(async () => {
    const result = await db.query(
      `SELECT occurred_at, metadata->>'username' AS username, host(ip_address) AS ip
       FROM audit_log
       WHERE module = 'auth' AND action = 'login_failed'
       ORDER BY occurred_at DESC LIMIT 10`
    );
    return result.rows.map((row) => ({
      at: row.occurred_at,
      username: row.username ?? null,
      ip: row.ip ?? null
    }));
  }, []);

  return {
    status: database === "ok" ? "ok" : "degraded",
    serverTime: new Date().toISOString(),
    database: { status: database, latencyMs: databaseLatencyMs },
    migrations: { count: migrationCount, last: lastMigration },
    lastBackupAt: lastBackup,
    failedLogins24h,
    recentFailedLogins,
    recentErrors: recentErrors.slice(0, 20)
  };
}
