import pg from "pg";

const { Pool } = pg;

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const maxConnections = readPositiveInteger("DB_POOL_MAX", 10);
const idleTimeoutMillis = readPositiveInteger("DB_IDLE_TIMEOUT_MS", 10_000);
const connectionTimeoutMillis = readPositiveInteger("DB_CONNECTION_TIMEOUT_MS", 10_000);
const statementTimeout = process.env.DB_STATEMENT_TIMEOUT_MS
  ? readPositiveInteger("DB_STATEMENT_TIMEOUT_MS", 30_000)
  : undefined;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: maxConnections,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  keepAlive: true,
  ...(statementTimeout ? { statement_timeout: statementTimeout } : {})
});

pool.on("error", (error) => {
  // A client can fail while idle in the pool; keep the process alive and
  // surface the failure without logging connection strings or credentials.
  console.error("Unexpected idle PostgreSQL client error", {
    message: error.message,
    code: (error as Error & { code?: string }).code
  });
});

export function getPoolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: maxConnections
  };
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
