import { test } from "node:test";
import assert from "node:assert/strict";
import { pgDateKey } from "../src/modules/payroll/pg-date-key.js";

// node-pg builds DATE values with the process timezone (local-midnight Date).
// Formatting that object with toISOString() shifts the calendar day outside UTC;
// local getters round-trip it under any process TZ.
test("pgDateKey recovers the stored calendar date in any timezone", () => {
  assert.equal(pgDateKey(new Date(2099, 0, 1)), "2099-01-01");
  assert.equal(pgDateKey(new Date(2099, 11, 31)), "2099-12-31");
  assert.equal(pgDateKey("2099-01-01"), "2099-01-01");
  assert.equal(pgDateKey("2099-01-01T00:00:00.000Z"), "2099-01-01");
});
