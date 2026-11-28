import test from "node:test";
import assert from "node:assert/strict";
import { countRequestedTable, parseRequestedTables } from "../src/modules/data-transfer/data-transfer-counts.service.js";

test("selected table counts accept one to five qualified table names", () => {
  assert.deepEqual(
    parseRequestedTables("public.workers, public.orders"),
    [
      { schema: "public", table: "workers", key: "public.workers" },
      { schema: "public", table: "orders", key: "public.orders" }
    ]
  );
});

test("selected table counts reject empty, duplicate, malformed, and oversized selections", () => {
  assert.throws(() => parseRequestedTables(undefined), /حدد أسماء الجداول/);
  assert.throws(() => parseRequestedTables("public.workers,public.workers"), /صيغة أسماء/);
  assert.throws(() => parseRequestedTables("public.workers; DROP TABLE users"), /صيغة أسماء/);
  assert.throws(() => parseRequestedTables("public.workers,,public.orders"), /صيغة أسماء/);
  assert.throws(() => parseRequestedTables("public.workers,"), /صيغة أسماء/);
  assert.throws(() => parseRequestedTables(",public.workers"), /صيغة أسماء/);
  assert.throws(() => parseRequestedTables("public.workers,   ,public.orders"), /صيغة أسماء/);
  assert.throws(
    () => parseRequestedTables("public.a,public.b,public.c,public.d,public.e,public.f"),
    /من 1 إلى 5/
  );
});

test("table count uses a read-only transaction, local timeout, quoted identifiers, and commit", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT 1")) return { rowCount: 1, rows: [{}] };
      if (sql.startsWith("SELECT count(*)")) return { rowCount: 1, rows: [{ exact_rows: "42" }] };
      return { rowCount: null, rows: [] };
    }
  };
  const result = await countRequestedTable(client as never, {
    schema: "public", table: "workers", key: "public.workers"
  });
  assert.deepEqual(result, { table: "public.workers", status: "counted", exactRows: "42" });
  assert.equal(calls[0]?.sql, "BEGIN READ ONLY");
  assert.match(calls[1]?.sql ?? "", /statement_timeout = '1500ms'/);
  assert.equal(calls[2]?.sql, "SET LOCAL row_security = off");
  assert.match(calls[3]?.sql ?? "", /n\.nspname = \$1 AND c\.relname = \$2/);
  assert.deepEqual(calls[3]?.values, ["public", "workers"]);
  assert.match(calls[4]?.sql ?? "", /FROM "public"\."workers"/);
  assert.equal(calls[5]?.sql, "COMMIT");
  assert.equal(calls.some(call => call.sql === "ROLLBACK"), false);
});

test("missing table rolls back without issuing a count query", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.startsWith("SELECT 1")) return { rowCount: 0, rows: [] };
      return { rowCount: null, rows: [] };
    }
  };
  const result = await countRequestedTable(client as never, {
    schema: "public", table: "missing_table", key: "public.missing_table"
  });
  assert.deepEqual(result, { table: "public.missing_table", status: "missing", exactRows: null });
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.some(sql => sql.startsWith("SELECT count(*)")), false);
});

test("statement timeout rolls back and is reported without an exact count", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.startsWith("SELECT 1")) return { rowCount: 1, rows: [{}] };
      if (sql.startsWith("SELECT count(*)")) throw Object.assign(new Error("statement timeout"), { code: "57014" });
      return { rowCount: null, rows: [] };
    }
  };
  const result = await countRequestedTable(client as never, {
    schema: "public", table: "large_table", key: "public.large_table"
  });
  assert.deepEqual(result, { table: "public.large_table", status: "timeout", exactRows: null });
  assert.equal(calls.at(-1), "ROLLBACK");
});


test("row-level security errors fail closed instead of returning a partial exact count", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.startsWith("SELECT 1")) return { rowCount: 1, rows: [{}] };
      if (sql.startsWith("SELECT count(*)")) throw Object.assign(new Error("row-level security is enabled"), { code: "42501" });
      return { rowCount: null, rows: [] };
    }
  };
  const result = await countRequestedTable(client as never, {
    schema: "public", table: "secured_table", key: "public.secured_table"
  });
  assert.deepEqual(result, { table: "public.secured_table", status: "unavailable", exactRows: null });
  assert.ok(calls.includes("SET LOCAL row_security = off"));
  assert.equal(calls.at(-1), "ROLLBACK");
});
