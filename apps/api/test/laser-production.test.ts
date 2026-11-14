import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateExpectedQuantity,
  isRunQuantityWithinExpected,
  calculateScrapRatePercent,
  monthlyTargetBounds
} from "../src/modules/production/laser-production.math.js";

test("expected output is cycles multiplied by pieces per cycle", () => {
  assert.equal(calculateExpectedQuantity(12, 8), 96);
});

test("expected output rejects invalid cycle counts and piece counts", () => {
  assert.throws(() => calculateExpectedQuantity(0, 8));
  assert.throws(() => calculateExpectedQuantity(1.5, 8));
  assert.throws(() => calculateExpectedQuantity(2, 0));
});

test("good output plus scrap cannot exceed expected output", () => {
  assert.equal(isRunQuantityWithinExpected(100, 80, 20), true);
  assert.equal(isRunQuantityWithinExpected(100, 80, 21), false);
  assert.equal(isRunQuantityWithinExpected(100, -1, 2), false);
  assert.equal(isRunQuantityWithinExpected(100, 80, Number.NaN), false);
});

test("scrap rate uses good plus scrap as the denominator and avoids division by zero", () => {
  assert.equal(calculateScrapRatePercent(90, 10), 10);
  assert.equal(calculateScrapRatePercent(0, 0), 0);
  assert.throws(() => calculateScrapRatePercent(-1, 0));
});

test("monthly target starts on the selected date and ends at month end", () => {
  assert.deepEqual(monthlyTargetBounds("2026-10-15"), { from: "2026-10-15", to: "2026-10-31" });
  assert.deepEqual(monthlyTargetBounds("2024-02-20"), { from: "2024-02-20", to: "2024-02-29" });
  assert.throws(() => monthlyTargetBounds("2026-02-30"));
});
