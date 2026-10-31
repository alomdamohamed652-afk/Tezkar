import assert from "node:assert/strict";
import test from "node:test";
import { calculateWorkedMinutes, findEffectiveAttendanceSchedule, selectAttendanceDayEvents, type AttendancePunchEvent, type EffectiveAttendanceSchedule } from "../src/modules/attendance/attendance-calculation.js";
import { suggestBoundaryPunchCorrections, type PunchCorrectionCandidate } from "../src/modules/attendance/attendance-corrections.js";

function punch(id: string, status: string, minute: number, extra: Partial<AttendancePunchEvent> = {}): AttendancePunchEvent {
  return {
    id,
    status,
    minute,
    punch_at: `2026-10-15T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    localDate: "2026-10-15",
    suspicious: false,
    review_status: "AUTO_ACCEPTED",
    ...extra,
  };
}

test("overtime checkout does not satisfy regular shift checkout", () => {
  const result = selectAttendanceDayEvents([
    punch("in", "IN", 8 * 60),
    punch("ot-out", "OVERTIME_OUT", 19 * 60),
  ]);
  assert.equal(result.inPunch?.id, "in");
  assert.equal(result.outPunch, null);
  assert.equal(result.otOut?.id, "ot-out");
});

test("a normal in/out pair is not flagged solely for having two events", () => {
  const result = selectAttendanceDayEvents([
    punch("in", "IN", 8 * 60),
    punch("out", "OUT", 17 * 60),
  ]);
  assert.equal(result.inPunch?.id, "in");
  assert.equal(result.outPunch?.id, "out");
  assert.equal(result.needsReview, false);
});

test("same-time repeated clock-in is treated as an accidental duplicate for calculations", () => {
  const result = selectAttendanceDayEvents([
    punch("in-1", "IN", 15 * 60),
    punch("in-2", "IN", 15 * 60),
    punch("out", "OUT", 23 * 60),
  ]);
  assert.equal(result.inPunch?.id, "in-1");
  assert.equal(result.outPunch?.id, "out");
  assert.equal(result.multipleNormalIns, false);
  assert.deepEqual(result.duplicateIds, ["in-2"]);
  assert.equal(result.duplicatePunchCount, 1);
  assert.equal(result.needsReview, true);
});

test("same-type punch within two minutes is duplicate; later repeat is a distinct event", () => {
  const duplicate = selectAttendanceDayEvents([
    punch("in-1", "IN", 15 * 60),
    punch("in-2", "IN", 15 * 60 + 1),
    punch("out", "OUT", 23 * 60),
  ]);
  assert.deepEqual(duplicate.duplicateIds, ["in-2"]);
  assert.equal(duplicate.multipleNormalIns, false);

  const later = selectAttendanceDayEvents([
    punch("in-1", "IN", 15 * 60),
    punch("in-2", "IN", 15 * 60 + 5),
    punch("out", "OUT", 23 * 60),
  ]);
  assert.deepEqual(later.duplicateIds, []);
  assert.equal(later.multipleNormalIns, true);
  assert.equal(later.needsReview, true);
});

test("reviewed repeated clock-in no longer keeps the day flagged", () => {
  const result = selectAttendanceDayEvents([
    punch("clock-in-15", "IN", 15 * 60),
    punch("clock-in-23", "IN", 23 * 60, { review_status: "APPROVED" }),
  ]);
  assert.equal(result.multipleNormalIns, true);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.reviewPunchIds, []);
});

test("pending or suspicious punches require review", () => {
  assert.equal(selectAttendanceDayEvents([
    punch("pending", "IN", 8 * 60, { review_status: "PENDING" }),
  ]).needsReview, true);
  assert.equal(selectAttendanceDayEvents([
    punch("suspicious", "OUT", 17 * 60, { suspicious: true }),
  ]).needsReview, true);
});

test("multiple overtime punches within the duplicate window collapse to one but remain reviewable", () => {
  const result = selectAttendanceDayEvents([
    punch("ot-in-1", "OVERTIME_IN", 17 * 60),
    punch("ot-in-2", "OVERTIME_IN", 17 * 60 + 1),
    punch("ot-out", "OVERTIME_OUT", 19 * 60),
  ]);
  assert.equal(result.multipleOvertimeIns, false);
  assert.deepEqual(result.duplicateIds, ["ot-in-2"]);
  assert.equal(result.needsReview, true);
});


function correctionPunch(id: string, status: string, minute: number, extra: Partial<Pick<PunchCorrectionCandidate, "corrected_status" | "correction_decision">> = {}): PunchCorrectionCandidate {
  return {
    id,
    status,
    minute,
    punch_at: `2026-10-15T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    localDate: "2026-10-15",
    corrected_status: null,
    correction_decision: null,
    ...extra,
  };
}

test("suggests OUT-at-shift-start as IN when another punch is near shift end", () => {
  const suggestions = suggestBoundaryPunchCorrections({
    punches: [
      correctionPunch("early", "OUT", 15 * 60),
      correctionPunch("end", "OUT", 23 * 60),
    ],
    shiftDate: "2026-10-15",
    startMinute: 15 * 60,
    endMinute: 23 * 60,
    overnight: false,
  });
  assert.deepEqual(suggestions.map((s) => [s.id, s.originalStatus, s.suggestedStatus]), [
    ["early", "OUT", "IN"],
  ]);
});

test("suggests IN-at-shift-end as OUT when another punch is near shift start", () => {
  const suggestions = suggestBoundaryPunchCorrections({
    punches: [
      correctionPunch("start", "IN", 15 * 60),
      correctionPunch("late", "IN", 23 * 60),
    ],
    shiftDate: "2026-10-15",
    startMinute: 15 * 60,
    endMinute: 23 * 60,
    overnight: false,
  });
  assert.deepEqual(suggestions.map((s) => [s.id, s.originalStatus, s.suggestedStatus]), [
    ["late", "IN", "OUT"],
  ]);
});

test("does not suggest corrections without both boundary-side punches or after a decision", () => {
  const single = suggestBoundaryPunchCorrections({
    punches: [correctionPunch("only", "OUT", 15 * 60)],
    shiftDate: "2026-10-15",
    startMinute: 15 * 60,
    endMinute: 23 * 60,
    overnight: false,
  });
  const decided = suggestBoundaryPunchCorrections({
    punches: [
      correctionPunch("early", "OUT", 15 * 60, { correction_decision: "KEPT_ORIGINAL" }),
      correctionPunch("end", "OUT", 23 * 60),
    ],
    shiftDate: "2026-10-15",
    startMinute: 15 * 60,
    endMinute: 23 * 60,
    overnight: false,
  });
  assert.deepEqual(single, []);
  assert.deepEqual(decided, []);
});

test("does not suggest a correction for a single punch on a short shift", () => {
  const suggestions = suggestBoundaryPunchCorrections({
    punches: [correctionPunch("midpoint", "OUT", 17 * 60)],
    shiftDate: "2026-10-15",
    startMinute: 15 * 60,
    endMinute: 19 * 60,
    overnight: false,
  });
  assert.deepEqual(suggestions, []);
});


test("worked hours sum separate completed shifts rather than spanning breaks", () => {
  assert.equal(calculateWorkedMinutes([
    { status: "IN", punch_at: "2026-10-15T06:00:00.000Z" },
    { status: "OUT", punch_at: "2026-10-15T10:00:00.000Z" },
    { status: "IN", punch_at: "2026-10-15T12:00:00.000Z" },
    { status: "OUT", punch_at: "2026-10-15T16:00:00.000Z" },
  ]), 480);
});

test("worked hours include completed overtime pairs and ignore incomplete pairs", () => {
  assert.equal(calculateWorkedMinutes([
    { status: "IN", punch_at: "2026-10-15T06:00:00.000Z" },
    { status: "OUT", punch_at: "2026-10-15T14:00:00.000Z" },
    { status: "OVERTIME_IN", punch_at: "2026-10-15T14:00:00.000Z" },
    { status: "OVERTIME_OUT", punch_at: "2026-10-15T15:30:00.000Z" },
    { status: "IN", punch_at: "2026-10-15T17:00:00.000Z" },
  ]), 570);
});


test("effective-dated weekly schedules switch exactly on their boundary dates", () => {
  const schedules: EffectiveAttendanceSchedule[] = [
    { employee_id: "employee-1", weekday: 4, effective_from: "1900-01-01", effective_to: "2026-10-21", starts_at: "08:00", ends_at: "16:00", is_day_off: false },
    { employee_id: "employee-1", weekday: 4, effective_from: "2026-10-22", effective_to: "2026-11-04", starts_at: "09:00", ends_at: "17:00", is_day_off: false },
    { employee_id: "employee-1", weekday: 4, effective_from: "2026-11-05", effective_to: null, starts_at: "10:00", ends_at: "18:00", is_day_off: false },
  ];

  assert.equal(findEffectiveAttendanceSchedule(schedules, "employee-1", 4, "2026-10-15")?.starts_at, "08:00");
  assert.equal(findEffectiveAttendanceSchedule(schedules, "employee-1", 4, "2026-10-22")?.starts_at, "09:00");
  assert.equal(findEffectiveAttendanceSchedule(schedules, "employee-1", 4, "2026-10-29")?.starts_at, "09:00");
  assert.equal(findEffectiveAttendanceSchedule(schedules, "employee-1", 4, "2026-11-05")?.starts_at, "10:00");
});

test("effective-dated schedule lookup does not leak across employees or weekdays", () => {
  const schedules: EffectiveAttendanceSchedule[] = [
    { employee_id: "employee-1", weekday: 4, effective_from: "2026-10-22", effective_to: null, starts_at: "09:00", ends_at: "17:00", is_day_off: false },
  ];

  assert.equal(findEffectiveAttendanceSchedule(schedules, "employee-2", 4, "2026-10-22"), null);
  assert.equal(findEffectiveAttendanceSchedule(schedules, "employee-1", 5, "2026-10-22"), null);
  assert.equal(findEffectiveAttendanceSchedule(schedules, "employee-1", 4, "2026-10-15"), null);
});
