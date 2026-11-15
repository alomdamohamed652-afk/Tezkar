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
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarQuote: string | null = null;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      index += 1;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length;
        dollarQuote = null;
      } else {
        index += 1;
      }
      continue;
    }
    if (singleQuoted) {
      if (char === "'" && next === "'") index += 2;
      else {
        if (char === "'") singleQuoted = false;
        index += 1;
      }
      continue;
    }
    if (doubleQuoted) {
      if (char === '"' && next === '"') index += 2;
      else {
        if (char === '"') doubleQuoted = false;
        index += 1;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      index += 2;
    } else if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 2;
    } else if (char === "'") {
      singleQuoted = true;
      index += 1;
    } else if (char === '"') {
      doubleQuoted = true;
      index += 1;
    } else if (char === "$") {
      const tag = sql.slice(index).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        dollarQuote = tag;
        index += tag.length;
      } else {
        index += 1;
      }
    } else if (char === ";") {
      const statement = sql.slice(start, index).replace(/^\s*--.*$/gm, "").trim();
      if (statement) statements.push(statement);
      start = index + 1;
      index += 1;
    } else {
      index += 1;
    }
  }

  if (singleQuoted || doubleQuoted || blockCommentDepth > 0 || dollarQuote) {
    throw new Error("Unterminated SQL quote or comment in concurrent-index migration");
  }
  const finalStatement = sql.slice(start).replace(/^\s*--.*$/gm, "").trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}

for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  const client = await pool.connect();
  let migrationLockAcquired = false;

  try {
    // Serialize migration runners across app instances, including non-transactional DDL.
    await client.query("SELECT pg_advisory_lock(0, hashtext($1))", [migrationLockKey]);
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
      try {
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
      } finally {
        // Do not leak migration-only session settings to the shared connection pool.
        try {
          await client.query("RESET lock_timeout");
        } finally {
          // Attempt both resets even if one session-setting reset fails.
          await client.query("RESET statement_timeout");
        }
      }
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
    try {
      if (migrationLockAcquired) {
        await client.query("SELECT pg_advisory_unlock(0, hashtext($1))", [migrationLockKey]);
      }
    } finally {
      client.release();
    }
  }
}

await pool.end();
