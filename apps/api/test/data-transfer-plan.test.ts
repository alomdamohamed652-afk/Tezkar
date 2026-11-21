import test from "node:test";
import assert from "node:assert/strict";
import { buildTransferPlan } from "../src/modules/data-transfer/data-transfer-plan.service.js";

const table = (name: string, dependencies: string[] = [], status = "compatible") => ({
  table: name, status, sourceEstimate: 12, targetEstimate: 0, dependencies, hasPrimaryKey: true, differences: []
});

test("transfer plan orders referenced tables before dependent tables", () => {
  const plan = buildTransferPlan([
    table("public.order_items", ["public.orders"]),
    table("public.orders"),
    table("public.users")
  ]);
  assert.deepEqual(plan.readyOrder.map(item => item.table), [
    "public.orders", "public.order_items", "public.users"
  ]);
  assert.equal(plan.writeEnabled, false);
});

test("transfer plan blocks schema mismatches and tables depending on them", () => {
  const plan = buildTransferPlan([
    table("public.users", [], "schema_mismatch"),
    table("public.orders", ["public.users"])
  ]);
  assert.deepEqual(plan.readyOrder, []);
  assert.equal(plan.blocked.length, 2);
});

test("transfer plan defers cyclic foreign-key dependencies", () => {
  const plan = buildTransferPlan([
    table("public.a", ["public.b"]),
    table("public.b", ["public.a"])
  ]);
  assert.equal(plan.readyOrder.length, 0);
  assert.equal(plan.deferred.length, 2);
});

test("transfer plan blocks references outside the eligible public table set", () => {
  const plan = buildTransferPlan([table("public.profiles", ["auth.users"])]);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0].reason, /خارج نطاق/);
});

test("transfer plan blocks tables without primary keys", () => {
  const plan = buildTransferPlan([{
    ...table("public.audit_log"),
    hasPrimaryKey: false
  }]);
  assert.equal(plan.readyOrder.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0].reason, /مفتاح أساسي/);
});
