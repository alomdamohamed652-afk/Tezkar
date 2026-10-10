import assert from "node:assert/strict";
import test from "node:test";
import { calculatePayrollDeduction } from "../src/modules/payroll/payroll-calculation.js";

test("fixed deduction rounds the payable amount to two decimal places", () => {
  const result = calculatePayrollDeduction({
    baseSalary: 6000, bonusAmount: 500, mode: "FIXED", basis: "BASE_SALARY",
    percentage: null, fixedAmount: 200.129
  });
  assert.equal(result.amount, 200.13);
});

test("percentage deduction can use base salary only", () => {
  assert.deepEqual(calculatePayrollDeduction({
    baseSalary: 6000, bonusAmount: 500, mode: "PERCENTAGE", basis: "BASE_SALARY",
    percentage: 5, fixedAmount: 0
  }), { basisAmount: 6000, amount: 300 });
});

test("percentage deduction can use base salary plus bonus", () => {
  assert.deepEqual(calculatePayrollDeduction({
    baseSalary: 6000, bonusAmount: 500, mode: "PERCENTAGE", basis: "BASE_PLUS_BONUS",
    percentage: 5, fixedAmount: 0
  }), { basisAmount: 6500, amount: 325 });
});

test("percentage calculation rounds to two decimal places", () => {
  assert.deepEqual(calculatePayrollDeduction({
    baseSalary: 1000, bonusAmount: 0, mode: "PERCENTAGE", basis: "BASE_SALARY",
    percentage: 2.345, fixedAmount: 0
  }), { basisAmount: 1000, amount: 23.45 });
});

test("percentage deduction rejects missing, zero, negative and over-100 values", () => {
  for (const percentage of [null, 0, -1, 100.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => calculatePayrollDeduction({
      baseSalary: 6000, bonusAmount: 500, mode: "PERCENTAGE", basis: "BASE_SALARY",
      percentage, fixedAmount: 0
    }), RangeError);
  }
});
