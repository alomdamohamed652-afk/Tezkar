import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reportsRoutes = readFileSync(
  new URL("../src/modules/reports/reports.routes.ts", import.meta.url),
  "utf8",
);

test("production report summary excludes worker payments already allocated through earnings settlements", () => {
  const match = reportsRoutes.match(/const summaryJoins = `([\s\S]*?)`;/);
  assert.ok(match, "summaryJoins must be defined");

  assert.match(
    match[1],
    /NOT EXISTS\(SELECT 1 FROM employee_earnings_settlements es JOIN employee_earnings_settlement_allocations esa ON esa\.settlement_id=es\.id WHERE es\.worker_payment_id=wp\.id\)/,
    "unallocated summary must exclude payments already represented by employee earnings settlements",
  );
});
