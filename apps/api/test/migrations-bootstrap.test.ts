import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.TEST_DATABASE_URL;

test("migrations apply to an empty PostgreSQL database and are idempotent", { skip: !adminUrl && "TEST_DATABASE_URL not set" }, async () => {
  const name = "tezkar_test_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const target = new URL(adminUrl!);
  target.pathname = "/" + name;
  const apiDir = new URL(".", import.meta.url).pathname.replace(/\/test\/$/, "");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: target.toString() },
    encoding: "utf8"
  });

  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /applied:/);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /^applied:/m);
    assert.match(second.stdout, /skipped:/);
  } finally {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
});
