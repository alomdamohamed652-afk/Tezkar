import assert from "node:assert/strict";
import test from "node:test";
import { calculatePayrollDeduction, calculatePayrollExpenseAmount } from "../src/modules/payroll/payroll-calculation.js";
import { calculatePayrollAttendance } from "../src/modules/payroll/payroll-attendance-calculation.js";

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


test("salary expense reconciliation adds advance repayment back to take-home pay", () => {
  assert.equal(calculatePayrollExpenseAmount(5700, 300), 6000);
  assert.equal(calculatePayrollExpenseAmount(0, 6000), 6000);
});


test("minute-based attendance payroll uses 26 days x 8 hours and prices all deduction minutes", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [
      { date: "2026-11-02", status: "PRESENT", lateMinutes: 30, earlyMinutes: 15, unpaidPermissionMinutes: 60 },
      { date: "2026-11-03", status: "ABSENT" },
      { date: "2026-11-04", status: "PRESENT", overtimeMinutes: 120 },
      { date: "2026-11-05", status: "DAY_OFF_WITH_PUNCH", isDayOff: true, workedMinutes: 480 }
    ]
  });
  assert.equal(result.scheduledMinutes, 12480);
  assert.equal(result.minuteRate, 0.4808);
  assert.equal(result.deductionMinutes, 585);
  assert.equal(result.deductionAmount, 281.25);
  assert.equal(result.overtimeBonus, 86.54);
  assert.equal(result.dayOffBonus, 200);
  assert.equal(result.totalBonus, 286.54);
});

test("minute-based attendance payroll refuses unresolved and missing-punch days", () => {
  const policy = { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 };
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 6000, existingBonus: 0, policy,
    days: [{ date: "2026-11-02", status: "PRESENT", needsReview: true }]
  }), /ATTENDANCE_REVIEW_REQUIRED/);
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 6000, existingBonus: 0, policy,
    days: [{ date: "2026-11-02", status: "MISSING_PUNCH" }]
  }), /ATTENDANCE_MISSING_PUNCH/);
});


test("minute-based payroll requires a configured rest-day rate when a rest day was worked", () => {
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 0, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-06", status: "DAY_OFF_WITH_PUNCH", isDayOff: true, workedMinutes: 240 }]
  }), /DAY_OFF_RATE_REQUIRED/);
});


test("paid permission time is credited against a full-day absence before deduction", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-07", status: "ABSENT", paidPermissionMinutes: 120 }]
  });
  assert.equal(result.paidPermissionMinutes, 120);
  assert.equal(result.absenceMinutes, 360);
  assert.equal(result.deductionAmount, 173.08);
});


test("minute-based payroll blocks worked days without a schedule classification", () => {
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-08", status: "NO_SCHEDULE_WITH_PUNCH", workedMinutes: 240 }]
  }), /ATTENDANCE_SCHEDULE_REQUIRED/);
});
