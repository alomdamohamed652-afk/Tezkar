import test from "node:test";
import assert from "node:assert/strict";
import {
  databaseIdentity,
  inspectDatabaseTransfer
} from "../src/modules/data-transfer/data-transfer-inspection.service.js";

test("database identity normalizes hostname case and PostgreSQL default port", () => {
  assert.equal(
    databaseIdentity("postgres://user:secret@DB.EXAMPLE/tezkar?sslmode=require"),
    "db.example:5432/tezkar"
  );
  assert.equal(
    databaseIdentity("postgres://other:password@db.example:5432/tezkar"),
    "db.example:5432/tezkar"
  );
});

test("database identity returns null for malformed connection strings", () => {
  assert.equal(databaseIdentity("not-a-database-url"), null);
});

test("inspection refuses identical database endpoints before opening connections", async () => {
  await assert.rejects(
    () => inspectDatabaseTransfer(
      "postgres://user:secret@DB.EXAMPLE/tezkar",
      "postgres://other:password@db.example:5432/tezkar"
    ),
    /نفس قاعدة البيانات/
  );
});


test("database identity distinguishes projects on the shared Supabase pooler hostname", () => {
  assert.notEqual(
    databaseIdentity("postgres://postgres.project_old:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"),
    databaseIdentity("postgres://postgres.project_new:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")
  );
});

test("database identity still treats different users on the same direct PostgreSQL endpoint as the same database", () => {
  assert.equal(
    databaseIdentity("postgres://user_a:secret@db.example/tezkar"),
    databaseIdentity("postgres://user_b:secret@db.example:5432/tezkar")
  );
});
