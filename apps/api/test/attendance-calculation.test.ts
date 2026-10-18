import assert from "node:assert/strict";
import test from "node:test";
import { selectAttendanceDayEvents, type AttendancePunchEvent } from "../src/modules/attendance/attendance-calculation.js";

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
