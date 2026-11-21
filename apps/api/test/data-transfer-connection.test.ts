import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDistinctDatabaseIdentities,
  assertReadOnlySourceSession,
  createReadOnlySourcePool,
  SOURCE_READ_ONLY_OPTIONS
} from "../src/modules/data-transfer/data-transfer-connection.service.js";

test("source pool enforces default_transaction_read_only at PostgreSQL session startup", () => {
  const pool = createReadOnlySourcePool("postgres://readonly:secret@source.example/tezkar");
  assert.equal(SOURCE_READ_ONLY_OPTIONS, "-c default_transaction_read_only=on");
  return pool.end();
});

test("source session guard accepts only a server-confirmed read-only session", async () => {
  await assertReadOnlySourceSession({
    async query(sql: string) {
      assert.equal(sql, "SHOW transaction_read_only");
      return { rows: [{ transaction_read_only: "on" }] };
    }
  } as never);
});

test("source session guard fails closed when PostgreSQL does not confirm read-only", async () => {
  await assert.rejects(
    () => assertReadOnlySourceSession({
      async query() { return { rows: [{ transaction_read_only: "off" }] }; }
    } as never),
    /ليس للقراءة فقط/
  );
});

test("database guard rejects missing or identical endpoint identities", () => {
  assert.throws(() => assertDistinctDatabaseIdentities(null, "target:5432/postgres"));
  assert.throws(() => assertDistinctDatabaseIdentities("same:5432/postgres", "same:5432/postgres"));
  assert.doesNotThrow(() => assertDistinctDatabaseIdentities("source:5432/postgres", "target:5432/postgres"));
});
