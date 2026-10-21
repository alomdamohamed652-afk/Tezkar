import assert from "node:assert/strict";
import test from "node:test";
import { selectAttendanceDayEvents, type AttendancePunchEvent } from "../src/modules/attendance/attendance-calculation.js";
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
