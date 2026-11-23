import test from "node:test";
import assert from "node:assert/strict";
import { databaseIdentity } from "../src/modules/data-transfer/data-transfer-inspection.service.js";
import {
  assertDistinctDatabaseIdentities,
  assertReadOnlySession,
  createReadOnlySourcePool,
  createTargetPool,
  SOURCE_READ_ONLY_OPTIONS
} from "../src/modules/data-transfer/data-transfer-connection.service.js";

test("source pool enforces default_transaction_read_only at PostgreSQL session startup", () => {
  const pool = createReadOnlySourcePool("postgres://readonly:secret@source.example/tezkar");
  assert.equal(SOURCE_READ_ONLY_OPTIONS, "-c default_transaction_read_only=on");
  return pool.end();
});

test("target inspection pool enforces the same PostgreSQL read-only startup setting", () => {
  const pool = createTargetPool("postgres://readonly:secret@target.example/tezkar");
  assert.equal(SOURCE_READ_ONLY_OPTIONS, "-c default_transaction_read_only=on");
  return pool.end();
});

test("session guard explicitly sets read-only mode before verifying PostgreSQL", async () => {
  const statements: string[] = [];
  await assertReadOnlySession({
    async query(sql: string) {
      statements.push(sql);
      if (sql === "SHOW transaction_read_only") {
        return { rows: [{ transaction_read_only: "on" }] };
      }
      return { rows: [] };
    }
  } as never);
  assert.deepEqual(statements, [
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
    "SHOW transaction_read_only"
  ]);
});

test("session guard fails closed when PostgreSQL does not confirm read-only", async () => {
  await assert.rejects(
    () => assertReadOnlySession({
      async query(sql: string) {
        if (sql === "SHOW transaction_read_only") {
          return { rows: [{ transaction_read_only: "off" }] };
        }
        return { rows: [] };
      }
    } as never),
    /ليس للقراءة فقط/
  );
});

test("session guard fails closed if the pooler refuses the read-only session setting", async () => {
  await assert.rejects(
    () => assertReadOnlySession({
      async query(sql: string) {
        if (sql.startsWith("SET SESSION")) throw new Error("read-only setting rejected");
        return { rows: [{ transaction_read_only: "off" }] };
      }
    } as never),
    /read-only setting rejected/
  );
});

test("database guard rejects missing or identical endpoint identities", () => {
  assert.throws(() => assertDistinctDatabaseIdentities(null, "target:5432/postgres"));
  assert.throws(() => assertDistinctDatabaseIdentities("same:5432/postgres", "same:5432/postgres"));
  assert.doesNotThrow(() => assertDistinctDatabaseIdentities("source:5432/postgres", "target:5432/postgres"));
});


test("Supabase direct and pooler URLs normalize to the same project identity", () => {
  const direct = databaseIdentity("postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres");
  const sessionPooler = databaseIdentity("postgresql://postgres.abcdefghijklmnop:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
  const transactionPooler = databaseIdentity("postgresql://postgres.abcdefghijklmnop:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  assert.equal(direct, "supabase:abcdefghijklmnop/postgres");
  assert.equal(sessionPooler, direct);
  assert.equal(transactionPooler, direct);
});

test("different Supabase project refs remain distinct across direct and pooler URLs", () => {
  const source = databaseIdentity("postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres");
  const target = databaseIdentity("postgresql://postgres.qrstuvwxyzabcdef:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  assert.equal(source, "supabase:abcdefghijklmnop/postgres");
  assert.equal(target, "supabase:qrstuvwxyzabcdef/postgres");
  assert.notEqual(source, target);
  assert.doesNotThrow(() => assertDistinctDatabaseIdentities(source, target));
});

test("same Supabase project is rejected when one URL is direct and the other pooled", () => {
  const direct = databaseIdentity("postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres");
  const pooled = databaseIdentity("postgresql://postgres.abcdefghijklmnop:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  assert.equal(direct, pooled);
  assert.throws(() => assertDistinctDatabaseIdentities(direct, pooled));
});

test("Supabase URLs with unrecognized pooler usernames fail closed as non-Supabase identities", () => {
  const unknown = databaseIdentity("postgresql://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  assert.equal(unknown, "aws-0-us-east-1.pooler.supabase.com:6543/postgres");
});
