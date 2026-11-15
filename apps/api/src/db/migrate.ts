import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(currentDir, "migrations");
const migrationLockKey = "tezkar:schema-migrations";

const files = (await readdir(migrationsDir))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort((a, b) => {
    const an = Number(a.match(/^\d+/)?.[0] ?? 0);
    const bn = Number(b.match(/^\d+/)?.[0] ?? 0);
    return an - bn || a.localeCompare(b);
  });

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

function getConcurrentIndexNames(sql: string): string[] {
  return [...sql.matchAll(/CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)]
    .map((match) => match[1]!);
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  const client = await pool.connect();
  let migrationLockAcquired = false;

  try {
    // Serialize migration runners across app instances, including non-transactional DDL.
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockKey]);
    migrationLockAcquired = true;

    const existing = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version]
    );

    if (existing.rowCount) {
      console.log(`skipped: ${file}`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const isConcurrentIndexMigration = sql.startsWith("-- @non-transactional-indexes");

    if (isConcurrentIndexMigration) {
      const indexNames = getConcurrentIndexNames(sql);
      if (indexNames.length === 0) {
        throw new Error(`Concurrent-index migration has no supported index statements: ${file}`);
      }

      // CONCURRENTLY cannot run in a transaction. A failed build can leave an invalid
      // index behind; remove only those invalid indexes before retrying the migration.
      await client.query("SET lock_timeout = '5s'");
      await client.query("SET statement_timeout = '0'");

      for (const indexName of indexNames) {
        const state = await client.query(
          `SELECT i.indisvalid
             FROM pg_class c
             JOIN pg_index i ON i.indexrelid = c.oid
            WHERE c.oid = to_regclass($1)`,
          [indexName]
        );
        if (state.rows[0]?.indisvalid === false) {
          console.warn(`removing invalid index before retry: ${indexName}`);
          await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
        }
      }

      for (const statement of splitSqlStatements(sql)) {
        await client.query(statement);
      }
      console.log(`applied concurrently: ${file}`);
      continue;
    }

    const maxLockAttempts = 3;
    let applied = false;

    for (let attempt = 1; attempt <= maxLockAttempts; attempt += 1) {
      console.log(`applying: ${file} (attempt ${attempt}/${maxLockAttempts})`);
      await client.query("BEGIN");

      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
          [version]
        );
        await client.query("COMMIT");
        console.log(`applied: ${file}`);
        applied = true;
        break;
      } catch (error) {
        await client.query("ROLLBACK");

        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
        if (code !== "55P03" || attempt === maxLockAttempts) {
          throw error;
        }

        const delayMs = attempt * 2_000;
        console.warn(
          `lock timeout: ${file}; retrying in ${delayMs}ms (${attempt}/${maxLockAttempts})`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (!applied) {
      throw new Error(`Migration did not complete: ${file}`);
    }
  } finally {
    if (migrationLockAcquired) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [migrationLockKey]);
    }
    client.release();
  }
}

await pool.end();
