import assert from "node:assert/strict";
import test from "node:test";
import { belongsToAttendanceShift, selectAttendanceDayEvents, type AttendancePunchEvent } from "../src/modules/attendance/attendance-calculation.js";

const event = (id: string, status: string, hour: number): AttendancePunchEvent => ({
  id,
  status,
  minute: hour * 60,
  punch_at: `2026-10-15T${String(hour).padStart(2, "0")}:00:00.000Z`,
  localDate: "2026-10-15",
  suspicious: false,
  review_status: "AUTO_ACCEPTED",
});

test("same-type clock-ins eight hours apart on the same workday require review", () => {
  const result = selectAttendanceDayEvents([
    event("clock-in-15", "IN", 15),
    event("clock-in-23", "IN", 23),
  ]);
  assert.equal(result.inPunch?.id, "clock-in-15");
  assert.equal(result.multipleNormalIns, true);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.reviewPunchIds, ["clock-in-23"]);
});


test("overnight shift accepts next-day checkout but never absorbs a next-day clock-in", () => {
  const common = {
    shiftDate: "2026-10-15",
    overnight: true,
    scheduledEndMinute: 7 * 60,
  };
  assert.equal(belongsToAttendanceShift({
    ...common,
    punchLocalDate: "2026-10-16",
    punchMinute: 6 * 60 + 45,
    punchStatus: "OUT",
  }), true);
  assert.equal(belongsToAttendanceShift({
    ...common,
    punchLocalDate: "2026-10-16",
    punchMinute: 3 * 60,
    punchStatus: "IN",
  }), false);
});

test("next-day punches are not assigned to a same-day shift", () => {
  assert.equal(belongsToAttendanceShift({
    punchLocalDate: "2026-10-16",
    punchMinute: 6 * 60,
    punchStatus: "OUT",
    shiftDate: "2026-10-15",
    overnight: false,
    scheduledEndMinute: 23 * 60,
  }), false);
});


test("an unmatched overtime entry blocks payroll and remains visible for correction", () => {
  const result = selectAttendanceDayEvents([
    event("regular-in", "IN", 8),
    event("regular-out", "OUT", 16),
    event("overtime-in", "OVERTIME_IN", 17),
  ]);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.unpairedPunchIds, ["overtime-in"]);
  assert.deepEqual(result.reviewPunchIds, ["overtime-in"]);
  assert.deepEqual(result.countedEvents, []);
});

test("complete regular and overtime pairs remain payable without a review flag", () => {
  const result = selectAttendanceDayEvents([
    event("regular-in", "IN", 8),
    event("regular-out", "OUT", 16),
    event("overtime-in", "OVERTIME_IN", 17),
    event("overtime-out", "OVERTIME_OUT", 19),
  ]);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.unpairedPunchIds, []);
  assert.equal(result.countedEvents.length, 4);
});

test("an approved but unmatched punch remains a correction candidate", () => {
  const approved = { ...event("approved-overtime-in", "OVERTIME_IN", 17), review_status: "APPROVED" };
  const result = selectAttendanceDayEvents([
    event("regular-in", "IN", 8),
    event("regular-out", "OUT", 16),
    approved,
  ]);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.reviewPunchIds, ["approved-overtime-in"]);
});
