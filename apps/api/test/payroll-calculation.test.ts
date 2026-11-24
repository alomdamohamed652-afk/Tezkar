import assert from "node:assert/strict";
import test from "node:test";
import { calculatePayrollDeduction, calculatePayrollExpenseAmount } from "../src/modules/payroll/payroll-calculation.js";
import { assertLeaveAllowanceFinalizable, calculatePayrollAttendance } from "../src/modules/payroll/payroll-attendance-calculation.js";

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


test("unpaid permission on a full absence is itemized separately without double deduction", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{
      date: "2026-11-07",
      status: "ABSENT",
      paidPermissionMinutes: 60,
      unpaidPermissionMinutes: 60
    }]
  });
  assert.equal(result.paidPermissionMinutes, 60);
  assert.equal(result.unpaidPermissionMinutes, 60);
  assert.equal(result.absenceMinutes, 360);
  assert.equal(result.deductionMinutes, 420);
  assert.equal(result.deductionAmount, 201.92);
});

test("minute-based payroll blocks worked days without a schedule classification", () => {
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-08", status: "NO_SCHEDULE_WITH_PUNCH", workedMinutes: 240 }]
  }), /ATTENDANCE_SCHEDULE_REQUIRED/);
});


test("minute-based payroll requires a schedule for every attendance day", () => {
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-09", status: "NO_SCHEDULE", workedMinutes: 0 }]
  }), /ATTENDANCE_SCHEDULE_REQUIRED/);
});


test("minute rate denominator is prorated for a salary active during half the month", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 3000,
    existingBonus: 0,
    policy: {
      workDaysPerMonth: 26,
      dailyWorkMinutes: 480,
      dayOffPayAmount: 0,
      overtimeMultiplier: 1.5,
      scheduledMinutes: 26 * 480 / 2
    },
    days: [{ date: "2026-11-20", status: "PRESENT", lateMinutes: 30 }]
  });
  assert.equal(result.scheduledMinutes, 6240);
  assert.equal(result.minuteRate, 0.4808);
  assert.equal(result.deductionMinutes, 30);
  assert.equal(result.deductionAmount, 14.42);
});

test("minute rate rejects a zero effective scheduled-minute denominator", () => {
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 3000,
    existingBonus: 0,
    policy: {
      workDaysPerMonth: 26,
      dailyWorkMinutes: 480,
      dayOffPayAmount: 0,
      overtimeMultiplier: 1.5,
      scheduledMinutes: 0
    },
    days: []
  }), /Invalid scheduled payroll minutes/);
});

test("unpaid leave deducts a full scheduled day itemized separately from absence", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-09", status: "UNPAID_LEAVE" }]
  });
  assert.equal(result.unpaidLeaveMinutes, 480);
  assert.equal(result.absenceMinutes, 0);
  assert.equal(result.dayOffWorkedMinutes, 0);
  assert.equal(result.deductionMinutes, 480);
  assert.equal(result.deductionAmount, 230.77);
});

test("unpaid leave and absence in the same month stay itemized and both deduct", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [
      { date: "2026-11-09", status: "UNPAID_LEAVE" },
      { date: "2026-11-10", status: "ABSENT" }
    ]
  });
  assert.equal(result.unpaidLeaveMinutes, 480);
  assert.equal(result.absenceMinutes, 480);
  assert.equal(result.deductionMinutes, 960);
  assert.equal(result.deductionAmount, 461.54);
});

test("paid leave day override carries no deduction and no rest-work bonus", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-09", status: "DAY_OFF", isDayOff: false, workedMinutes: 0 }]
  });
  assert.equal(result.deductionMinutes, 0);
  assert.equal(result.dayOffWorkedMinutes, 0);
  assert.equal(result.dayOffBonus, 0);
  assert.equal(result.totalBonus, 0);
});

test("manual presence on a scheduled workday deducts nothing and earns no rest bonus", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-09", status: "MANUAL", workedMinutes: 480 }]
  });
  assert.equal(result.deductionMinutes, 0);
  assert.equal(result.dayOffWorkedMinutes, 0);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.totalBonus, 0);
});

test("paid permission time is credited against an unpaid-leave day before deduction", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000,
    existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-09", status: "UNPAID_LEAVE", paidPermissionMinutes: 120 }]
  });
  assert.equal(result.paidPermissionMinutes, 120);
  assert.equal(result.unpaidLeaveMinutes, 360);
  assert.equal(result.deductionAmount, 173.08);
});

const flexMonthDays = (present: number, offWorked: number, offRest: number) => [
  ...Array.from({ length: present }, (_, i) => ({ date: "2026-11-" + String(i + 1).padStart(2, "0"), status: "PRESENT" })),
  ...Array.from({ length: offWorked }, (_, i) => ({ date: "2026-11-" + String(present + i + 1).padStart(2, "0"), status: "DAY_OFF_WITH_PUNCH", isDayOff: true, workedMinutes: 480 })),
  ...Array.from({ length: offRest }, (_, i) => ({ date: "2026-11-" + String(present + offWorked + i + 1).padStart(2, "0"), status: "DAY_OFF" })),
];

const flexPolicy = { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 300, overtimeMultiplier: 1.5, allowedLeaveDaysPerMonth: 4 };

test("flexible rest: 28 attended and 2 rested pays the 2 unused allowance days once at the configured rate", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: flexMonthDays(26, 2, 2)
  });
  assert.equal(result.attendedDays, 28);
  assert.equal(result.restDaysUsed, 2);
  assert.equal(result.leavePayoutDays, 2);
  assert.equal(result.leavePayoutAmount, 600);
  assert.equal(result.dayOffWorkedMinutes, 0);
  assert.equal(result.dayOffBonus, 0);
  assert.equal(result.deductionMinutes, 0);
});

test("flexible rest: full-month attendance pays out the entire allowance once", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: flexMonthDays(26, 4, 0)
  });
  assert.equal(result.attendedDays, 30);
  assert.equal(result.restDaysUsed, 0);
  assert.equal(result.leavePayoutDays, 4);
  assert.equal(result.leavePayoutAmount, 1200);
  assert.equal(result.dayOffBonus, 0);
});

test("flexible rest: attending exactly the prescribed days and using all allowance pays no compensation", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: flexMonthDays(26, 0, 4)
  });
  assert.equal(result.attendedDays, 26);
  assert.equal(result.restDaysUsed, 4);
  assert.equal(result.leavePayoutDays, 0);
  assert.equal(result.leavePayoutAmount, 0);
});

test("flexible rest: a manual paid-leave day consumes the shared allowance", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: [...flexMonthDays(25, 0, 4), { date: "2026-11-30", status: "DAY_OFF", isDayOff: false, workedMinutes: 0 }]
  });
  assert.equal(result.attendedDays, 25);
  assert.equal(result.restDaysUsed, 4);
  assert.equal(result.leavePayoutAmount, 0);
});

test("flexible rest: payout requires the configured day rate", () => {
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0,
    policy: { ...flexPolicy, dayOffPayAmount: 0 },
    days: flexMonthDays(26, 4, 0)
  }), /DAY_OFF_RATE_REQUIRED/);
});

test("flexible rest: unpaid leave deducts without consuming the paid allowance", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: [...flexMonthDays(26, 0, 3), { date: "2026-11-30", status: "UNPAID_LEAVE" }]
  });
  assert.equal(result.restDaysUsed, 3);
  assert.equal(result.leavePayoutDays, 1);
  assert.equal(result.leavePayoutAmount, 300);
  assert.equal(result.unpaidLeaveMinutes, 480);
  assert.equal(result.deductionMinutes, 480);
  assert.equal(result.deductionAmount, 300);
});

test("legacy policy without a configured allowance keeps the rest-day bonus behavior", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 6000, existingBonus: 0,
    policy: { workDaysPerMonth: 26, dailyWorkMinutes: 480, dayOffPayAmount: 200, overtimeMultiplier: 1.5 },
    days: [{ date: "2026-11-05", status: "DAY_OFF_WITH_PUNCH", isDayOff: true, workedMinutes: 480 }]
  });
  assert.equal(result.dayOffBonus, 200);
  assert.equal(result.leavePayoutDays, 0);
  assert.equal(result.leavePayoutAmount, 0);
  assert.equal(result.attendedDays, 0);
});

test("pool mode: an unreviewed no-punch workday blocks calculation instead of deducting or consuming the allowance", () => {
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: [...flexMonthDays(25, 0, 4), { date: "2026-11-30", status: "ABSENT" }]
  }), /ATTENDANCE_ABSENCE_UNCONFIRMED/);
});

test("pool mode: a manager-settled confirmed absence deducts a full day and does not consume the allowance", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: [...flexMonthDays(25, 0, 4), { date: "2026-11-30", status: "ABSENT", manualOverride: true }]
  });
  assert.equal(result.attendedDays, 25);
  assert.equal(result.restDaysUsed, 4);
  assert.equal(result.leavePayoutAmount, 0);
  assert.equal(result.absenceMinutes, 480);
  assert.equal(result.deductionAmount, 300);
});

test("pool mode: a partial salary period with unused allowance blocks the payout until a proration rule exists", () => {
  const preHire = Array.from({ length: 19 }, (_, i) => ({ date: "2026-11-" + String(i + 1).padStart(2, "0"), status: "NOT_STARTED" }));
  assert.throws(() => calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0,
    policy: { ...flexPolicy, scheduledMinutes: 26 * 480 * 11 / 30 },
    days: [...preHire, ...flexMonthDays(9, 0, 2).map((d, i) => ({ ...d, date: "2026-11-" + String(20 + i).padStart(2, "0") }))]
  }), /LEAVE_PAYOUT_PERIOD_UNRESOLVED/);
});

test("pool mode: a partial salary period with the allowance fully consumed approves without a payout", () => {
  const preHire = Array.from({ length: 19 }, (_, i) => ({ date: "2026-11-" + String(i + 1).padStart(2, "0"), status: "NOT_STARTED" }));
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0,
    policy: { ...flexPolicy, scheduledMinutes: 26 * 480 * 11 / 30 },
    days: [...preHire, ...flexMonthDays(7, 0, 4).map((d, i) => ({ ...d, date: "2026-11-" + String(20 + i).padStart(2, "0") }))]
  });
  assert.equal(result.restDaysUsed, 4);
  assert.equal(result.leavePayoutDays, 0);
  assert.equal(result.leavePayoutAmount, 0);
});


test("finalization guard: legacy policy without allowance ignores the month boundary", () => {
  assert.doesNotThrow(() => assertLeaveAllowanceFinalizable({ allowedLeaveDaysPerMonth: null, monthEnd: "2026-11-30", today: "2026-11-24" }));
});

test("finalization guard: allowance pool approves once the month is fully past", () => {
  assert.doesNotThrow(() => assertLeaveAllowanceFinalizable({ allowedLeaveDaysPerMonth: 4, monthEnd: "2026-11-30", today: "2026-12-01" }));
});

test("finalization guard: allowance pool blocks approval on the last day of the month itself", () => {
  assert.throws(() => assertLeaveAllowanceFinalizable({ allowedLeaveDaysPerMonth: 4, monthEnd: "2026-11-30", today: "2026-11-30" }), /LEAVE_PAYOUT_EARLY_FINALIZATION/);
});

test("finalization guard: allowance pool blocks approval mid-month", () => {
  assert.throws(() => assertLeaveAllowanceFinalizable({ allowedLeaveDaysPerMonth: 4, monthEnd: "2026-11-30", today: "2026-11-24" }), /LEAVE_PAYOUT_EARLY_FINALIZATION/);
});

test("pool mode: an explicit confirmed-absence settlement on a rest-scheduled day wins over the schedule flag and deducts", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: [...flexMonthDays(26, 0, 3), { date: "2026-11-30", status: "ABSENT", isDayOff: true, manualOverride: true }]
  });
  assert.equal(result.restDaysUsed, 3);
  assert.equal(result.leavePayoutDays, 1);
  assert.equal(result.absenceMinutes, 480);
  assert.equal(result.deductionAmount, 300);
});

test("pool mode: an explicit unpaid-leave settlement on a rest-scheduled day wins over the schedule flag and deducts as leave", () => {
  const result = calculatePayrollAttendance({
    baseSalary: 7800, existingBonus: 0, policy: flexPolicy,
    days: [...flexMonthDays(26, 0, 3), { date: "2026-11-30", status: "UNPAID_LEAVE", isDayOff: true, manualOverride: true }]
  });
  assert.equal(result.restDaysUsed, 3);
  assert.equal(result.leavePayoutDays, 1);
  assert.equal(result.unpaidLeaveMinutes, 480);
  assert.equal(result.absenceMinutes, 0);
  assert.equal(result.deductionAmount, 300);
});
