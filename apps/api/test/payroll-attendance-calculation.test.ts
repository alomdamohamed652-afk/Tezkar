import assert from "node:assert/strict";
import test from "node:test";
import { calculateAttendancePayroll } from "../src/modules/payroll/payroll-calculation.js";
import { signAttendanceSnapshot, verifyAttendanceSnapshot } from "../src/modules/attendance/attendance-snapshot-signature.js";

test("attendance payroll deducts absence and late/early time using scheduled monthly minutes", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 6000, overtimeMultiplier: 1.5,
    days: [
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "ABSENT" },
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "PRESENT", lateMinutes: 10, earlyMinutes: 5 }
    ]
  });
  assert.equal(result.scheduledMinutes, 960);
  assert.equal(result.missingMinutes, 495);
  assert.equal(result.absenceMinutes, 480);
  assert.equal(result.lateMinutes, 10);
  assert.equal(result.earlyMinutes, 5);
  assert.equal(result.timeDeduction, 3093.75);
  assert.equal(result.reviewDays, 0);
});

test("attendance payroll pays approved overtime at the configured multiplier", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 6000, overtimeMultiplier: 1.5,
    days: [{ scheduledStart: "08:00", scheduledEnd: "16:00", status: "PRESENT", overtimeMinutes: 120 }]
  });
  assert.equal(result.hourlyRate, 750);
  assert.equal(result.overtimeBonus, 2250);
});

test("incomplete or suspicious attendance is not automatically deducted or paid as overtime", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 3000, overtimeMultiplier: 2,
    days: [
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "MISSING_PUNCH", needsReview: true, overtimeMinutes: 60 },
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "PRESENT", needsReview: true, lateMinutes: 60, overtimeMinutes: 60 },
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "ABSENT" }
    ]
  });
  assert.equal(result.scheduledMinutes, 1440);
  assert.equal(result.missingMinutes, 480);
  assert.equal(result.timeDeduction, 1000);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.reviewDays, 2);
});

test("overnight schedules use their actual cross-midnight duration", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 2400, overtimeMultiplier: 1.5,
    days: [{ scheduledStart: "20:00", scheduledEnd: "04:00", status: "ABSENT" }]
  });
  assert.equal(result.scheduledMinutes, 480);
  assert.equal(result.timeDeduction, 2400);
});

test("salary-inactive calendar days do not dilute the hourly rate", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 3000, overtimeMultiplier: 1.5,
    days: [
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "PRESENT", salaryActive: false, overtimeMinutes: 60 },
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "PRESENT", salaryActive: true, workedMinutes: 480 }
    ]
  });
  assert.equal(result.scheduledMinutes, 480);
  assert.equal(result.hourlyRate, 375);
  assert.equal(result.overtimeMinutes, 0);
});

test("attendance payroll validates the overtime multiplier", () => {
  assert.throws(() => calculateAttendancePayroll({baseSalary:1000,overtimeMultiplier:0.5,days:[]}), RangeError);
});

test("manual attendance overrides are included in time deductions", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 3000, overtimeMultiplier: 1.5,
    days: [{
      scheduledStart: "08:00", scheduledEnd: "16:00", status: "MANUAL",
      workedMinutes: 450, lateMinutes: 10, earlyMinutes: 20
    }]
  });
  assert.equal(result.scheduledMinutes, 480);
  assert.equal(result.workedMinutes, 450);
  assert.equal(result.missingMinutes, 30);
  assert.equal(result.timeDeduction, 187.5);
});

test("manually marked days off do not dilute scheduled minutes or earn stale overtime", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 3000, overtimeMultiplier: 1.5,
    days: [
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "DAY_OFF", overtimeMinutes: 60 },
      { scheduledStart: "08:00", scheduledEnd: "16:00", status: "PRESENT", workedMinutes: 480 }
    ]
  });
  assert.equal(result.scheduledMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.timeDeduction, 0);
  assert.equal(result.overtimeBonus, 0);
});

test("manual attendance days never inherit or receive fingerprint overtime", () => {
  const result = calculateAttendancePayroll({
    baseSalary: 3000, overtimeMultiplier: 1.5,
    days: [{
      scheduledStart: "08:00", scheduledEnd: "16:00", status: "MANUAL",
      workedMinutes: 480, overtimeMinutes: 120
    }]
  });
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.overtimeBonus, 0);
});


test("signed attendance snapshots reject edited and expired rows", () => {
  const issuedAt = Date.now();
  const signed = signAttendanceSnapshot({
    date: "2026-11-04",
    employeeId: "00000000-0000-4000-8000-000000000001",
    status: "PRESENT",
    workedMinutes: 480,
    overtimeMinutes: 60
  }, issuedAt);

  assert.equal(verifyAttendanceSnapshot(signed, issuedAt), true);
  assert.equal(verifyAttendanceSnapshot({ ...signed, workedMinutes: 1 }, issuedAt), false);
  assert.equal(verifyAttendanceSnapshot(signed, issuedAt + 16 * 60 * 1000), false);
});
