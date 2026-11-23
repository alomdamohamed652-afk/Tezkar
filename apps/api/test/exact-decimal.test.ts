import assert from "node:assert/strict";
import test from "node:test";
import { decimalEquals, decimalIsZero, normalizeDecimal } from "../src/modules/account-health/exact-decimal.js";

test("balances that differ by 0.0001 are not equal even beyond double precision", () => {
  // Both strings collapse to the same JS number, which is the bug this guards against.
  assert.equal(Number("12345678901234.5678"), Number("12345678901234.5679"));
  assert.equal(decimalEquals("12345678901234.5678", "12345678901234.5679"), false);
  assert.equal(decimalEquals("-12345678901234.5678", "-12345678901234.5679"), false);
  assert.equal(decimalEquals("0.0001", "0.0000"), false);
});

test("equal decimals compare equal regardless of formatting", () => {
  assert.equal(decimalEquals("-12.3457", "-12.34570"), true);
  assert.equal(decimalEquals("12.0000", "12"), true);
  assert.equal(decimalEquals("0012.5", "12.5000"), true);
  assert.equal(decimalEquals("-0.0000", "0"), true);
});

test("zero detection is exact and rejects malformed input", () => {
  assert.equal(decimalIsZero("0.0000"), true);
  assert.equal(decimalIsZero("0.0001"), false);
  assert.throws(() => normalizeDecimal("abc"));
  assert.throws(() => normalizeDecimal(""));
});
