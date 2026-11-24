import test from "node:test";
import assert from "node:assert/strict";
import { applySalaryComponentsToDraft } from "../src/modules/payroll/salary-components.service.js";

type Call = { sql: string; values: unknown[] };
function mockClient(handlers: Array<[string, unknown[]]>) {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      for (const [needle, rows] of handlers) if (sql.includes(needle)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

test("applySalaryComponentsToDraft replaces only component lines and recomputes totals", async () => {
  const client = mockClient([
    ["INSERT INTO payroll_adjustment_lines", [{ id: "l1" }, { id: "l2" }]],
    ["violations-marker-never", []],
  ]);
  const count = await applySalaryComponentsToDraft(client as any, "period-1", "user-1");
  assert.equal(count, 2);
  assert.equal(client.calls.length, 4);
  // 1. Deletes only component-generated lines of this period.
  assert.ok(client.calls[0].sql.includes("DELETE FROM payroll_adjustment_lines"));
  assert.ok(client.calls[0].sql.includes("salary_component_id IS NOT NULL"));
  assert.ok(client.calls[0].sql.includes("WHERE period_id=$1"));
  assert.deepEqual(client.calls[0].values, ["period-1"]);
  // 2. Inserts from active components only, tagged with the component id.
  assert.ok(client.calls[1].sql.includes("c.is_active=TRUE"));
  assert.ok(client.calls[1].sql.includes("salary_component_id"));
  assert.deepEqual(client.calls[1].values, ["period-1", "user-1"]);
  // 3. Recomputes bonus/deduction totals from all ACTIVE lines (manual + generated).
  assert.ok(client.calls[2].sql.includes("UPDATE payroll_items"));
  assert.ok(client.calls[2].sql.includes("status='ACTIVE'"));
  // 4. Validates the net-pay constraint.
  assert.ok(client.calls[3].sql.includes("base_salary + i.bonus_amount < i.deduction_amount"));
});

test("applySalaryComponentsToDraft throws a readable error naming the employee when deductions exceed pay", async () => {
  const client = mockClient([
    ["INSERT INTO payroll_adjustment_lines", [{ id: "l1" }]],
    ["base_salary + i.bonus_amount < i.deduction_amount", [{ full_name: "أحمد محمود" }]],
  ]);
  await assert.rejects(
    () => applySalaryComponentsToDraft(client as any, "period-1", "user-1"),
    (error: any) => {
      assert.equal(error.code, "SALARY_COMPONENTS_EXCEED_SALARY");
      assert.ok(error.message.includes("أحمد محمود"));
      return true;
    }
  );
});

test("zero active components is a no-op that still zeroes stale generated lines", async () => {
  const client = mockClient([]);
  const count = await applySalaryComponentsToDraft(client as any, "period-1", "user-1");
  assert.equal(count, 0);
  assert.equal(client.calls.length, 4);
});
