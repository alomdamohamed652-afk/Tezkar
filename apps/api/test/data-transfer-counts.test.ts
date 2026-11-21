import test from "node:test";
import assert from "node:assert/strict";
import { parseRequestedTables } from "../src/modules/data-transfer/data-transfer-counts.service.js";

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
