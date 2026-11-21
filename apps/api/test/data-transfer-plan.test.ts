import assert from "node:assert/strict";
import test from "node:test";
import { buildTransferOrder } from "../src/modules/data-transfer/data-transfer-plan.js";

test("orders referenced parent tables before child tables", () => {
  const result = buildTransferOrder(
    [
      { name: "payments", primaryKey: ["id"] },
      { name: "workers", primaryKey: ["id"] },
      { name: "orders", primaryKey: ["id"] }
    ],
    [
      { table: "payments", referencedTable: "workers", deferrable: false, initiallyDeferred: false },
      { table: "payments", referencedTable: "orders", deferrable: false, initiallyDeferred: false }
    ]
  );
  assert.deepEqual(result.orderedTables, ["orders", "workers", "payments"]);
  assert.deepEqual(result.blockedTables, []);
  assert.deepEqual(result.blockers, []);
});

test("blocks cycles instead of guessing an insertion order", () => {
  const result = buildTransferOrder(
    [
      { name: "a", primaryKey: ["id"] },
      { name: "b", primaryKey: ["id"] }
    ],
    [
      { table: "a", referencedTable: "b", deferrable: true, initiallyDeferred: true },
      { table: "b", referencedTable: "a", deferrable: true, initiallyDeferred: true }
    ]
  );
  assert.deepEqual(result.orderedTables, []);
  assert.deepEqual(result.blockedTables, ["a", "b"]);
  assert.match(result.blockers.join(" "), /cycle/i);
});

test("blocks self-referencing non-deferred foreign keys", () => {
  const result = buildTransferOrder(
    [{ name: "tree", primaryKey: ["id"] }],
    [{ table: "tree", referencedTable: "tree", deferrable: true, initiallyDeferred: false }]
  );
  assert.deepEqual(result.orderedTables, []);
  assert.deepEqual(result.blockedTables, ["tree"]);
  assert.match(result.blockers.join(" "), /Self-referencing/);
});

test("blocks tables without primary keys but keeps independent safe tables", () => {
  const result = buildTransferOrder(
    [
      { name: "unsafe", primaryKey: [] },
      { name: "safe", primaryKey: ["id"] }
    ],
    []
  );
  assert.deepEqual(result.orderedTables, ["safe"]);
  assert.deepEqual(result.blockedTables, ["unsafe"]);
  assert.match(result.blockers.join(" "), /no primary key/);
});

test("blocks foreign keys that reference tables outside the inspected set", () => {
  const result = buildTransferOrder(
    [{ name: "public_table", primaryKey: ["id"] }],
    [{ table: "public_table", referencedTable: "external_table", deferrable: false, initiallyDeferred: false }]
  );
  assert.deepEqual(result.orderedTables, []);
  assert.deepEqual(result.blockedTables, ["public_table"]);
  assert.match(result.blockers.join(" "), /outside the inspected set/);
});

test("blocks child tables when a referenced parent has no primary key", () => {
  const result = buildTransferOrder(
    [
      { name: "parent", primaryKey: [] },
      { name: "child", primaryKey: ["id"] },
      { name: "independent", primaryKey: ["id"] }
    ],
    [{ table: "child", referencedTable: "parent", deferrable: false, initiallyDeferred: false }]
  );
  assert.deepEqual(result.orderedTables, ["independent"]);
  assert.deepEqual(result.blockedTables, ["child", "parent"]);
});

test("propagates an unsafe parent through multiple dependency levels", () => {
  const result = buildTransferOrder(
    [
      { name: "root", primaryKey: [] },
      { name: "middle", primaryKey: ["id"] },
      { name: "leaf", primaryKey: ["id"] }
    ],
    [
      { table: "middle", referencedTable: "root", deferrable: false, initiallyDeferred: false },
      { table: "leaf", referencedTable: "middle", deferrable: false, initiallyDeferred: false }
    ]
  );
  assert.deepEqual(result.orderedTables, []);
  assert.deepEqual(result.blockedTables, ["leaf", "middle", "root"]);
});

test("produces deterministic order for disconnected tables", () => {
  const result = buildTransferOrder(
    [
      { name: "zeta", primaryKey: ["id"] },
      { name: "alpha", primaryKey: ["id"] },
      { name: "middle", primaryKey: ["id"] }
    ],
    []
  );
  assert.deepEqual(result.orderedTables, ["alpha", "middle", "zeta"]);
});
