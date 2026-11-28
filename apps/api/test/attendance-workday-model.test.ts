import assert from "node:assert/strict";
import test from "node:test";
import { buildAttendanceReport } from "../src/modules/attendance/attendance-report.service.js";

type MockPunch = {
  id: string;
  employee_id: string;
  device_code: string;
  punch_at: Date;
  corrected_punch_at: null;
  status: string;
  corrected_status: null;
  correction_decision: null;
  correction_note: null;
  correction_reviewed_by: null;
  correction_reviewed_at: null;
  verify_method: string;
  suspicious: boolean;
  review_status: string;
};

const employee = {
  id: "employee-1",
  code: "EMP-1",
  full_name: "Employee One",
  device_code: "1",
  late_grace_minutes: 10,
  early_grace_minutes: 5,
  overnight_checkout_grace_minutes: 120,
};

function punch(id: string, status: string, utcIso: string): MockPunch {
  return {
    id,
    employee_id: employee.id,
    device_code: employee.device_code,
    punch_at: new Date(utcIso),
    corrected_punch_at: null,
    status,
    corrected_status: null,
    correction_decision: null,
    correction_note: null,
    correction_reviewed_by: null,
    correction_reviewed_at: null,
    verify_method: "FINGERPRINT",
    suspicious: false,
    review_status: "AUTO_ACCEPTED",
  };
}

function schedule(weekday: number, startsAt: string | null, endsAt: string | null, isDayOff = false) {
  return {
    employee_id: employee.id,
    weekday,
    starts_at: startsAt,
    ends_at: endsAt,
    is_day_off: isDayOff,
    effective_from: "1900-01-01",
    effective_to: null,
  };
}

function mockDb(input: { schedules: unknown[]; punches: MockPunch[]; exceptions?: unknown[]; permissions?: unknown[] }) {
  return {
    async query(sql: string) {
      if (sql.includes("FROM employees e")) return { rows: [employee] };
      if (sql.includes("FROM attendance_weekly_schedule_versions")) return { rows: input.schedules };
      if (sql.includes("FROM attendance_schedule_exceptions")) return { rows: input.exceptions ?? [] };
      if (sql.includes("FROM attendance_punches")) return { rows: input.punches };
      if (sql.includes("FROM attendance_day_overrides")) return { rows: [] };
      if (sql.includes("FROM attendance_permission_requests")) return { rows: input.permissions ?? [] };
      throw new Error("Unexpected attendance report query: " + sql);
    },
  };
}

// 2026-11-16 is a Monday, 2026-11-17 a Tuesday, 2026-11-18 a Wednesday (Cairo = UTC+2 in November).

test("overnight checkout beyond the grace window still belongs to the overnight workday and is flagged for review", async () => {
  const db = mockDb({
    schedules: [schedule(1, "22:00", "06:00")],
    punches: [
      punch("night-in", "IN", "2026-11-16T20:00:00.000Z"), // 22:00 Cairo Monday
      punch("late-out", "OUT", "2026-11-17T07:00:00.000Z"), // 09:00 Cairo Tuesday, past the 08:00 grace cutoff
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-16", "2026-11-16");
  assert.equal(result.data.length, 1);
  const row = result.data[0];
  assert.equal(row.status, "PRESENT");
  assert.equal(row.workedMinutes, 660); // 22:00 -> 09:00
  assert.equal(row.earlyMinutes, 0);
  assert.equal(row.overnightCheckoutBeyondGrace, true);
  assert.equal(row.needsReview, true);
});

test("an overnight shift does not steal a next-day checkout that pairs with that day's own clock-in", async () => {
  const db = mockDb({
    schedules: [schedule(1, "22:00", "06:00"), schedule(2, "08:00", "16:00")],
    punches: [
      punch("night-in", "IN", "2026-11-16T20:00:00.000Z"), // 22:00 Cairo Monday
      punch("day-in", "IN", "2026-11-17T06:00:00.000Z"), // 08:00 Cairo Tuesday
      punch("day-out", "OUT", "2026-11-17T14:00:00.000Z"), // 16:00 Cairo Tuesday
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-16", "2026-11-17");
  const monday = result.data.find(row => row.date === "2026-11-16");
  const tuesday = result.data.find(row => row.date === "2026-11-17");
  assert.equal(monday.status, "MISSING_PUNCH"); // genuinely missing the night checkout
  assert.equal(monday.overnightCheckoutBeyondGrace, false);
  assert.equal(tuesday.status, "PRESENT");
  assert.equal(tuesday.workedMinutes, 480);
});

test("a full-duration day at shifted hours is flagged outside schedule with no late, early or overtime", async () => {
  const db = mockDb({
    schedules: [schedule(3, "08:00", "16:00")],
    punches: [
      punch("in", "IN", "2026-11-18T08:00:00.000Z"), // 10:00 Cairo
      punch("out", "OUT", "2026-11-18T16:00:00.000Z"), // 18:00 Cairo
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-18", "2026-11-18");
  const row = result.data[0];
  assert.equal(row.status, "PRESENT");
  assert.equal(row.workedMinutes, 480);
  assert.equal(row.outsideSchedule, true);
  assert.equal(row.lateMinutes, 0);
  assert.equal(row.earlyMinutes, 0);
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(result.summary.outsideSchedule, 1);
});

test("a full-duration day shifted earlier is also flagged outside schedule with no early-arrival credit", async () => {
  const db = mockDb({
    schedules: [schedule(3, "08:00", "16:00")],
    punches: [
      punch("in", "IN", "2026-11-18T04:00:00.000Z"), // 06:00 Cairo
      punch("out", "OUT", "2026-11-18T12:00:00.000Z"), // 14:00 Cairo
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-18", "2026-11-18");
  const row = result.data[0];
  assert.equal(row.outsideSchedule, true);
  assert.equal(row.workedMinutes, 480);
  assert.equal(row.lateMinutes, 0);
  assert.equal(row.earlyMinutes, 0);
  assert.equal(row.earlyArrivalMinutes, 0);
  assert.equal(row.lateDepartureMinutes, 0);
  assert.equal(row.overtimeMinutes, 0);
});

test("a longer day (early in and late out) keeps the existing boundary overtime handling", async () => {
  const db = mockDb({
    schedules: [schedule(3, "08:00", "16:00")],
    punches: [
      punch("in", "IN", "2026-11-18T05:00:00.000Z"), // 07:00 Cairo
      punch("out", "OUT", "2026-11-18T15:00:00.000Z"), // 17:00 Cairo
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-18", "2026-11-18");
  const row = result.data[0];
  assert.equal(row.outsideSchedule, false);
  assert.equal(row.workedMinutes, 600);
  assert.equal(row.earlyArrivalMinutes, 60);
  assert.equal(row.lateDepartureMinutes, 60);
  assert.equal(row.overtimeMinutes, 120);
});

test("a short shifted day is a normal late day, not outside schedule", async () => {
  const db = mockDb({
    schedules: [schedule(3, "08:00", "16:00")],
    punches: [
      punch("in", "IN", "2026-11-18T08:00:00.000Z"), // 10:00 Cairo
      punch("out", "OUT", "2026-11-18T14:00:00.000Z"), // 16:00 Cairo
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-18", "2026-11-18");
  const row = result.data[0];
  assert.equal(row.outsideSchedule, false);
  assert.equal(row.lateMinutes, 110);
});

test("a dated exception marks a normal working day as a rest day", async () => {
  const db = mockDb({
    schedules: [schedule(3, "08:00", "16:00")],
    exceptions: [{
      id: "exception-1",
      employee_id: employee.id,
      start_date: "2026-11-18",
      end_date: "2026-11-18",
      starts_at: null,
      ends_at: null,
      is_day_off: true,
      note: "إجازة خاصة",
    }],
    punches: [],
  });
  const result = await buildAttendanceReport(db, "2026-11-18", "2026-11-18");
  assert.equal(result.data[0].status, "DAY_OFF");
});

test("a dated exception turns a usual rest day into a working day with its own hours", async () => {
  // Friday (weekday 5) is the weekly day off; 2026-11-20 is a Friday.
  const db = mockDb({
    schedules: [schedule(5, null, null, true)],
    exceptions: [{
      id: "exception-2",
      employee_id: employee.id,
      start_date: "2026-11-20",
      end_date: "2026-11-20",
      starts_at: "09:00",
      ends_at: "17:00",
      is_day_off: false,
      note: "تبديل إجازة",
    }],
    punches: [
      punch("in", "IN", "2026-11-20T07:00:00.000Z"), // 09:00 Cairo
      punch("out", "OUT", "2026-11-20T15:00:00.000Z"), // 17:00 Cairo
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-20", "2026-11-20");
  const row = result.data[0];
  assert.equal(row.status, "PRESENT");
  assert.equal(row.isDayOff, false);
  assert.equal(row.workedMinutes, 480);
  assert.equal(row.lateMinutes, 0);
  assert.equal(row.earlyMinutes, 0);
});

function permission(date: string, startsAt: string, endsAt: string, type: string, minutes: number) {
  return {
    employee_id: employee.id,
    permission_date: date,
    permission_type: type,
    duration_minutes: minutes,
    starts_at: startsAt,
    ends_at: endsAt,
  };
}

test("a cross-midnight permission counts toward the overnight workday it starts on", async () => {
  const db = mockDb({
    schedules: [schedule(1, "22:00", "06:00")],
    permissions: [permission("2026-11-16", "23:30", "00:30", "PAID", 60)],
    punches: [
      punch("in", "IN", "2026-11-16T20:00:00.000Z"), // 22:00 Cairo Monday
      punch("out", "OUT", "2026-11-17T04:00:00.000Z"), // 06:00 Cairo Tuesday
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-16", "2026-11-16");
  const row = result.data[0];
  assert.equal(row.status, "PRESENT");
  assert.equal(row.permissionMinutes, 60);
  assert.equal(row.paidPermissionMinutes, 60);
  assert.equal(row.payableWorkedMinutes, 480 + 60);
});

test("an early-morning permission dated the next day counts toward the overnight workday it belongs to", async () => {
  const db = mockDb({
    schedules: [schedule(1, "22:00", "06:00")],
    permissions: [permission("2026-11-17", "00:30", "01:30", "UNPAID", 60)],
    punches: [
      punch("in", "IN", "2026-11-16T20:00:00.000Z"), // 22:00 Cairo Monday
      punch("out", "OUT", "2026-11-17T04:00:00.000Z"), // 06:00 Cairo Tuesday
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-16", "2026-11-16");
  const row = result.data[0];
  assert.equal(row.permissionMinutes, 60);
  assert.equal(row.unpaidPermissionMinutes, 60);
});

test("a permission covering the late window cancels late minutes on an overnight workday", async () => {
  const db = mockDb({
    schedules: [schedule(1, "22:00", "06:00")],
    permissions: [permission("2026-11-16", "22:00", "23:00", "PAID", 60)],
    punches: [
      punch("in", "IN", "2026-11-16T21:00:00.000Z"), // 23:00 Cairo, 50 minutes late after the 10-minute grace
      punch("out", "OUT", "2026-11-17T04:00:00.000Z"), // 06:00 Cairo Tuesday
    ],
  });
  const result = await buildAttendanceReport(db, "2026-11-16", "2026-11-16");
  const row = result.data[0];
  assert.equal(row.latePermissionOverlapMinutes, 50);
  assert.equal(row.lateMinutes, 0);
});
