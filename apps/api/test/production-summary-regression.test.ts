import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const productionRoutes = readFileSync(
  new URL("../src/modules/production/production.routes.ts", import.meta.url),
  "utf8",
);

test("production report remaining summary subtracts all allocated payments", () => {
  const match = productionRoutes.match(/const remainingSql = `([\s\S]*?)`;/);
  assert.ok(match, "remainingSql must be defined");
  const expression = match[1];

  assert.match(
    expression,
    /-\s*COALESCE\(\(SELECT SUM\(a\.amount\) FROM worker_payment_order_allocations/,
    "order-scoped payment allocations must reduce the remaining balance",
  );
  assert.match(
    expression,
    /-\s*COALESCE\(\(SELECT SUM\(wpa\.amount\) FROM worker_payment_allocations/,
    "legacy payment allocations must reduce the remaining balance",
  );
  assert.match(
    expression,
    /-\s*COALESCE\(\(SELECT SUM\(a\.amount\) FROM employee_earnings_settlement_allocations/,
    "settlement allocations must reduce the remaining balance",
  );
  assert.doesNotMatch(
    expression,
    /\+\s*COALESCE/,
    "no payment allocation source may be added to the remaining balance",
  );
});
