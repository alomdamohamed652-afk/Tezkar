import assert from "node:assert/strict";
import test from "node:test";
import { selectAttendanceDayEvents, type AttendancePunchEvent } from "../src/modules/attendance/attendance-calculation.js";

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
