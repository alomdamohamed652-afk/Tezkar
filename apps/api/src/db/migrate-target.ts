import { spawnSync } from "node:child_process";
import { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DatabaseIdentity = {
  database_name: string;
  server_address: string;
  server_port: number | null;
  server_started_at: string;
};

async function inspectIdentity(connectionString: string): Promise<DatabaseIdentity> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query(
      `SELECT current_database() AS database_name,
              COALESCE(inet_server_addr()::text, 'local') AS server_address,
              inet_server_port() AS server_port,
              pg_postmaster_start_time()::text AS server_started_at`
    );
    await client.query("ROLLBACK");
    return result.rows[0] as DatabaseIdentity;
  } finally {
    await client.end();
  }
}

async function inspectTarget(connectionString: string) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const settings = await client.query("SHOW default_transaction_read_only");
    const markers = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') AS auth_schema,
         EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') AS storage_schema,
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') AS supabase_admin`
    );
    const objects = await client.query(
      `SELECT count(*)::text AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r','p','v','m','S','f')`
    );
    const database = await client.query(
      "SELECT current_database() AS database_name, current_user"
    );
    await client.query("ROLLBACK");

    const marker = markers.rows[0]!;
    const publicObjectCount = Number(objects.rows[0]?.count ?? 0);
    const defaultReadOnly = String(settings.rows[0]?.default_transaction_read_only ?? "").toLowerCase() === "on";
    if (!marker.auth_schema || !marker.storage_schema || !marker.supabase_admin) {
      throw new Error("TARGET_DATABASE_URL لا يبدو أنه يشير إلى مشروع Supabase المتوقع؛ تم إيقاف التجهيز.");
    }
    if (defaultReadOnly) {
      throw new Error("اتصال الوجهة مضبوط للقراءة فقط؛ لا يمكن تشغيل migrations عليه.");
    }
    if (publicObjectCount !== 0) {
      throw new Error(`مخطط public في الوجهة يحتوي على ${publicObjectCount} كائنًا. لن يتم تشغيل migrations فوق قاعدة غير فارغة أو جزئية.`);
    }
    return {
      databaseName: database.rows[0]?.database_name ?? "unknown",
      databaseUser: database.rows[0]?.current_user ?? "unknown",
      publicObjectCount
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const sourceUrl = process.env.DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl || !targetUrl) {
    throw new Error("يلزم ضبط DATABASE_URL للمصدر وTARGET_DATABASE_URL لوجهة Supabase. لا يوجد fallback بينهما.");
  }

  const source = await inspectIdentity(sourceUrl);
  const targetIdentity = await inspectIdentity(targetUrl);
  if (
    source.database_name === targetIdentity.database_name &&
    source.server_address === targetIdentity.server_address &&
    source.server_port === targetIdentity.server_port &&
    source.server_started_at === targetIdentity.server_started_at
  ) {
    throw new Error("المصدر والوجهة يشيران إلى نفس خادم/قاعدة البيانات؛ تم الإيقاف دون كتابة.");
  }

  const target = await inspectTarget(targetUrl);
  console.log("Supabase target preflight passed.");
  console.log(`Target database: ${target.databaseName}; user: ${target.databaseUser}; public objects: ${target.publicObjectCount}.`);
  console.log("Source was inspected using a read-only transaction. No schema or data was changed.");

  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log("PREVIEW ONLY: no migrations were executed. Add --apply and set CONFIRM_TARGET_SCHEMA_MIGRATIONS=YES only after explicit approval.");
    return;
  }
  if (process.env.CONFIRM_TARGET_SCHEMA_MIGRATIONS !== "YES") {
    throw new Error("التنفيذ موقوف: يلزم CONFIRM_TARGET_SCHEMA_MIGRATIONS=YES مع --apply.");
  }

  // The existing migration runner reads DATABASE_URL. Override it only in this
  // child process, after the source/target identity and empty-target guards pass.
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const migrationScript = path.join(scriptDirectory, "migrate.ts");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", migrationScript],
    {
      cwd: path.resolve(scriptDirectory, "../.."),
      env: { ...process.env, DATABASE_URL: targetUrl },
      stdio: "inherit"
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  console.log("Target migrations completed. Re-run the read-only schema inspection before any data transfer.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown target migration error";
  console.error(`Target migration preparation failed: ${message}`);
  process.exitCode = 1;
});
