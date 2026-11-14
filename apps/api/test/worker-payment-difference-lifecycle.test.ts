import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient, QueryResult } from "pg";
import { allocatePendingWorkerPaymentDifferencesForProduction, processMaturedWorkerPaymentDifferences } from "../src/modules/payments/worker-payment-differences.service.js";

type Row = Record<string, unknown>;

function fakeClient(handler: (sql: string, values: unknown[]) => Promise<{ rows?: Row[]; rowCount?: number }>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const result = await handler(sql, values);
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 } as QueryResult;
    }
  };
  return { client: client as unknown as PoolClient, calls };
}

test("difference allocation creates a fresh immutable allocation for each reallocation cycle", async () => {
  const allocationIds = ["allocation-cycle-1", "allocation-cycle-2"];
  const eventAmounts: number[] = [];
  let activeAllocation = false;
  let remainingDifference = 40;
  let cycle = 0;

  const { client, calls } = fakeClient(async (sql, values) => {
    if (sql.includes("FROM production_entries p") && sql.includes("FOR UPDATE OF p")) {
      return { rows: [{ id: "production-1", employee_id: "employee-1", order_id: "order-target", order_stage_id: "stage-target", remaining: 40, approved_at: "2026-11-14T10:00:00Z", work_date: "2026-11-14" }] };
    }
    if (sql.includes("FROM worker_payment_settlement_differences d") && sql.includes("FOR UPDATE OF d")) {
      return { rows: [{ id: "difference-1", worker_payment_id: "payment-1", source_order_id: "order-source", source_expense_id: "expense-1", original_amount: 40, remaining: remainingDifference, payment_created_at: "2026-11-01T10:00:00Z" }] };
    }
    if (sql.includes("SELECT 1") && sql.includes("worker_payment_settlement_difference_events ev")) {
      return { rows: activeAllocation ? [{ "?column?": 1 }] : [] };
    }
    if (sql.includes("INSERT INTO worker_payment_order_allocations")) {
      const id = allocationIds[cycle++];
      return { rows: [{ id }] };
    }
    if (sql.includes("INSERT INTO worker_payment_settlement_difference_events")) {
      eventAmounts.push(Number(values[3]));
      return { rowCount: 1 };
    }
    if (sql.includes("SELECT GREATEST($2::numeric")) {
      return { rows: [{ remaining: 0 }] };
    }
    if (sql.includes("UPDATE worker_payment_settlement_differences")) return { rowCount: 1 };
    if (sql.includes("INSERT INTO audit_log")) return { rowCount: 1 };
    throw new Error("Unexpected SQL in lifecycle test: " + sql.slice(0, 180));
  });

  const first = await allocatePendingWorkerPaymentDifferencesForProduction(client, "employee-1", "production-1", "user-1");
  assert.equal(first.length, 1);
  assert.equal(first[0].amount, 40);
  activeAllocation = true;

  const duplicate = await allocatePendingWorkerPaymentDifferencesForProduction(client, "employee-1", "production-1", "user-1");
  assert.deepEqual(duplicate, [], "an active allocation for the same production entry must not be duplicated");

  // Model the append-only REVERSED event: the prior allocation is no longer active
  // and the original difference amount becomes available for a new cycle.
  activeAllocation = false;
  remainingDifference = 40;
  const second = await allocatePendingWorkerPaymentDifferencesForProduction(client, "employee-1", "production-1", "user-1");

  assert.equal(second.length, 1);
  assert.equal(second[0].amount, 40);
  assert.equal(cycle, 2);
  assert.deepEqual(eventAmounts, [40, 40]);
  const inserts = calls.filter(call => call.sql.includes("INSERT INTO worker_payment_order_allocations"));
  assert.equal(inserts.length, 2, "each cycle must have a distinct allocation row");
  assert.notDeepEqual(inserts[0].values, inserts[1].values);
});

test("difference allocation ignores production entries without a target order", async () => {
  let queryCount = 0;
  const { client } = fakeClient(async sql => {
    queryCount++;
    assert.ok(sql.includes("FOR UPDATE OF p"));
    return { rows: [{ id: "production-no-order", order_id: null, remaining: 100 }] };
  });

  const result = await allocatePendingWorkerPaymentDifferencesForProduction(client, "employee-1", "production-no-order", "user-1");
  assert.deepEqual(result, []);
  assert.equal(queryCount, 1, "must not inspect or mutate differences when no target order exists");
});

test("matured-difference sweep keeps the unpaid-approved-production blocker", async () => {
  let candidateSql = "";
  const { client } = fakeClient(async sql => {
    candidateSql = sql;
    return { rows: [] };
  });

  const transferred = await processMaturedWorkerPaymentDifferences(client, { actorUserId: null, actorType: "SYSTEM" });
  assert.equal(transferred, 0);
  assert.match(candidateSql, /AND NOT EXISTS\([\s\S]*?FROM production_entries p[\s\S]*?p\.status='APPROVED'[\s\S]*?productionRemainingSql/);
  assert.match(candidateSql, /productionRemainingSql/);
  assert.match(candidateSql, /FOR UPDATE OF e,d SKIP LOCKED/);
});
