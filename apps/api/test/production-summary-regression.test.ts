import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const productionRoutes = readFileSync(
  new URL("../src/modules/production/production.routes.ts", import.meta.url),
  "utf8",
);

test("production report remaining summary subtracts net allocated payments", () => {
  const match = productionRoutes.match(/const remainingSql = \`([\s\S]*?)\`;/);
  assert.ok(match, "remainingSql must be defined");
  const expression = match[1];

  assert.match(
    expression,
    /-\s*COALESCE\(\(SELECT SUM\(a\.amount-COALESCE\(\(SELECT SUM\(r\.amount\) FROM worker_payment_allocation_reversals r WHERE r\.allocation_source='WORKER_PAYMENT_ORDER'/,
    "order-scoped allocations must reduce remaining earnings by their unreversed amount",
  );
  assert.match(
    expression,
    /-\s*COALESCE\(\(SELECT SUM\(wpa\.amount-COALESCE\(\(SELECT SUM\(r\.amount\) FROM worker_payment_allocation_reversals r WHERE r\.allocation_source='WORKER_PAYMENT_LEGACY'/,
    "legacy allocations must reduce remaining earnings by their unreversed amount",
  );
  assert.match(
    expression,
    /-\s*COALESCE\(\(SELECT SUM\(a\.amount-COALESCE\(\(SELECT SUM\(r\.amount\) FROM worker_payment_allocation_reversals r WHERE r\.allocation_source='EMPLOYEE_EARNINGS_SETTLEMENT'/,
    "settlement allocations must reduce remaining earnings by their unreversed amount",
  );
  assert.doesNotMatch(
    expression,
    /\+\s*COALESCE/,
    "no payment allocation source may be added to the remaining balance",
  );
});
