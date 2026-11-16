import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(
  new URL("../src/modules/production/production.routes.ts", import.meta.url),
  "utf8",
);

const start = routes.indexOf('app.get("/api/production/my"');
const end = routes.indexOf('app.post("/api/production"', start);
assert.ok(start >= 0 && end > start, "worker production endpoint must exist");
const workerRoute = routes.slice(start, end);

test("worker production history remains scoped to the signed-in employee and selected dates", () => {
  assert.match(workerRoute, /request\.user\?\.employeeId/);
  assert.match(workerRoute, /p\.employee_id=\$1/);
  assert.match(workerRoute, /p\.status <> 'CANCELLED'/);
  assert.match(workerRoute, /p\.work_date >= \$/);
  assert.match(workerRoute, /p\.work_date <= \$/);
  assert.match(workerRoute, /a\.employee_id=\$1/);
  assert.match(workerRoute, /a\.adjustment_date >= \$/);
  assert.match(workerRoute, /a\.adjustment_date <= \$/);
});

test("worker paid amount keeps all canonical allocation sources and excludes reversed amounts", () => {
  for (const source of [
    "employee_earnings_settlement_allocations",
    "worker_payment_order_allocations",
    "worker_payment_allocations",
    "worker_payment_settlement_difference_events",
  ]) {
    assert.ok(workerRoute.includes(source), `paid amount must include ${source}`);
  }

  for (const reversalType of [
    "EMPLOYEE_EARNINGS_SETTLEMENT",
    "WORKER_PAYMENT_ORDER",
    "WORKER_PAYMENT_LEGACY",
  ]) {
    assert.ok(workerRoute.includes(`allocation_source='${reversalType}'`),
      `paid amount must subtract reversals for ${reversalType}`);
  }

  assert.match(workerRoute, /AS paid_amount/);
  assert.match(routes, /event_type='ALLOCATED_TO_PRODUCTION'/);
  assert.match(routes, /event_type='REVERSED'/);
});

test("worker remaining amount subtracts the same allocation sources used by paid amount", () => {
  const remainingStart = workerRoute.indexOf("GREATEST(COALESCE(p.total_earning_amount");
  const remainingEnd = workerRoute.indexOf(" AS remaining_amount", remainingStart);
  assert.ok(remainingStart >= 0 && remainingEnd > remainingStart,
    "remaining amount SQL expression must exist");
  const remaining = workerRoute.slice(remainingStart, remainingEnd);

  for (const source of [
    "employee_earnings_settlement_allocations",
    "worker_payment_order_allocations",
    "worker_payment_allocations",
    "worker_payment_settlement_difference_events",
  ]) {
    assert.ok(remaining.includes(source), `remaining amount must account for ${source}`);
  }
  assert.match(remaining, /allocation_source='EMPLOYEE_EARNINGS_SETTLEMENT'/);
  assert.match(remaining, /allocation_source='WORKER_PAYMENT_ORDER'/);
  assert.match(remaining, /allocation_source='WORKER_PAYMENT_LEGACY'/);
  assert.match(remaining, /^GREATEST\(/);
});

test("daily summary counts only standalone adjustments, avoiding production-linked double counting", () => {
  const dailyStart = workerRoute.indexOf("const daily=await pool.query(");
  const dailyEnd = workerRoute.indexOf("return {data:result.rows", dailyStart);
  assert.ok(dailyStart >= 0 && dailyEnd > dailyStart, "daily summary query must exist");
  const daily = workerRoute.slice(dailyStart, dailyEnd);

  assert.match(daily, /a\.production_entry_id IS NULL/);
  assert.match(daily, /adjustment_type='BONUS'/);
  assert.match(daily, /adjustment_type='DEDUCTION'/);
  assert.match(daily, /p\.status='APPROVED'/);
  assert.match(daily, /p\.status='PENDING'/);
  assert.match(daily, /FULL OUTER JOIN extras/);
});

test("adjustment detail list retains both production-linked and standalone adjustments", () => {
  const adjustmentsStart = workerRoute.indexOf("const adjustments=await pool.query(");
  const dailyStart = workerRoute.indexOf("const daily=await pool.query(", adjustmentsStart);
  assert.ok(adjustmentsStart >= 0 && dailyStart > adjustmentsStart,
    "adjustment detail query must exist");
  const adjustments = workerRoute.slice(adjustmentsStart, dailyStart);

  assert.match(adjustments, /FROM employee_earnings_adjustments a/);
  assert.match(adjustments, /LEFT JOIN production_entries p ON p\.id=a\.production_entry_id/);
  assert.match(adjustments, /WHERE a\.employee_id=\$1/);
  assert.doesNotMatch(adjustments, /a\.production_entry_id IS NULL/);
});
