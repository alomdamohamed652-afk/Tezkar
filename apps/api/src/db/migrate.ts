import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(currentDir, "migrations");

const files = (await readdir(migrationsDir))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort((a, b) => {
    const an = Number(a.match(/^\d+/)?.[0] ?? 0);
    const bn = Number(b.match(/^\d+/)?.[0] ?? 0);
    // Multiple migrations may intentionally share a numeric prefix.
    // Use the filename as a stable tie-breaker so all environments apply
    // those migrations in the same deterministic order.
    return an - bn || a.localeCompare(b);
  });

// Make the runner self-sufficient on an empty database; identical to 001_foundation.sql.
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  const client = await pool.connect();

  try {
    const existing = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version]
    );

    if (existing.rowCount) {
      console.log(`skipped: ${file}`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
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
    client.release();
  }
}

await pool.end();
