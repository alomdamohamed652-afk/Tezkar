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
    return an - bn;
  });

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

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [version]
      );
      await client.query("COMMIT");
      console.log(`applied: ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

await pool.end();
