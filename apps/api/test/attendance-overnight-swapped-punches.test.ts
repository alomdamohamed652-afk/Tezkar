import test from "node:test";
import assert from "node:assert/strict";
import { buildAttendanceReport } from "../src/modules/attendance/attendance-report.service.js";

// Overnight shifts and swapped IN/OUT punches.
// Verifies: an overnight shift counts as ONE workday on its start date, a
// next-morning IN that is really the overnight checkout is suggested (never
// rewritten) as OUT, a legit next-shift clock-in is never suggested, and
// swapped overtime pairs are flagged for review.

const employee = { id: "employee-1", code: "EMP-1", full_name: "Employee One", device_code: "1", late_grace_minutes: 10, early_grace_minutes: 5, overnight_checkout_grace_minutes: 120 };

function punch(id: string, status: string, utcIso: string) {
  return { id, employee_id: employee.id, device_code: employee.device_code, punch_at: new Date(utcIso), corrected_punch_at: null, status, corrected_status: null, correction_decision: null, correction_note: null, correction_reviewed_by: null, correction_reviewed_at: null, verify_method: "FINGERPRINT", suspicious: false, review_status: "AUTO_ACCEPTED" };
}
function schedule(weekday: number, startsAt: string | null, endsAt: string | null, isDayOff = false) {
  return { employee_id: employee.id, weekday, starts_at: startsAt, ends_at: endsAt, is_day_off: isDayOff, effective_from: "1900-01-01", effective_to: null };
}
function mockDb(input: { schedules: unknown[]; punches: unknown[] }) {
  return { async query(sql: string) {
    if (sql.includes("FROM employees e")) return { rows: [employee] };
    if (sql.includes("FROM attendance_weekly_schedule_versions")) return { rows: input.schedules };
    if (sql.includes("FROM attendance_schedule_exceptions")) return { rows: [] };
    if (sql.includes("FROM attendance_punches")) return { rows: input.punches };
    if (sql.includes("FROM attendance_day_overrides")) return { rows: [] };
    if (sql.includes("FROM attendance_permission_requests")) return { rows: [] };
    throw new Error("Unexpected query: " + sql);
  } };
}

// Night shift 22:00 -> 06:00 every day except Friday.
const nights = [0, 1, 2, 3, 4, 6].map((d) => schedule(d, "22:00", "06:00"));

test("overnight shift counts as one workday on its start date", async () => {
  const db = mockDb({ schedules: nights, punches: [
    punch("a", "IN", "2026-11-16T20:00:00.000Z"),   // Mon 22:00 Cairo
    punch("b", "OUT", "2026-11-17T04:00:00.000Z"),  // Tue 06:00 Cairo
  ]});
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-17");
  const monday = report.data.find((r: any) => r.date === "2026-11-16");
  const tuesday = report.data.find((r: any) => r.date === "2026-11-17");
  assert.equal(monday.status, "PRESENT");
  assert.equal(monday.workedMinutes, 480);
  // The checkout morning hours are not double-counted on Tuesday.
  assert.equal(tuesday.workedMinutes, 0);
});

test("consecutive overnight shifts each count once", async () => {
  const db = mockDb({ schedules: nights, punches: [
    punch("a", "IN", "2026-11-16T20:00:00.000Z"), punch("b", "OUT", "2026-11-17T04:00:00.000Z"),
    punch("c", "IN", "2026-11-17T20:00:00.000Z"), punch("d", "OUT", "2026-11-18T04:00:00.000Z"),
  ]});
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-18");
  assert.equal(report.data[0].status, "PRESENT");
  assert.equal(report.data[0].workedMinutes, 480);
  assert.equal(report.data[1].status, "PRESENT");
  assert.equal(report.data[1].workedMinutes, 480);
});

test("next-morning IN after an overnight shift without checkout is suggested as OUT and flagged for review", async () => {
  const db = mockDb({ schedules: nights, punches: [
    punch("a", "IN", "2026-11-16T20:00:00.000Z"),
    punch("b", "IN", "2026-11-17T04:00:00.000Z"),  // Tue 06:00, at the overnight end
  ]});
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-17");
  const monday = report.data.find((r: any) => r.date === "2026-11-16");
  assert.equal(monday.status, "MISSING_PUNCH");
  assert.equal(monday.needsReview, true);
  const suggestion = monday.correctionSuggestions.find((s: any) => s.id === "b");
  assert.ok(suggestion, "expected a suggestion for the next-morning IN");
  assert.equal(suggestion.originalStatus, "IN");
  assert.equal(suggestion.suggestedStatus, "OUT");
  // Suggestion only: the raw punch is untouched.
  assert.equal(monday.workedMinutes, 0);
});

test("the next night's own clock-in is never suggested as the previous night's checkout", async () => {
  const db = mockDb({ schedules: nights, punches: [
    punch("a", "IN", "2026-11-16T20:00:00.000Z"),
    punch("b", "IN", "2026-11-17T20:00:00.000Z"),  // Tue 22:00, Tuesday's real clock-in
  ]});
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-17");
  const monday = report.data.find((r: any) => r.date === "2026-11-16");
  const tuesday = report.data.find((r: any) => r.date === "2026-11-17");
  assert.deepEqual(monday.correctionSuggestions, []);
  assert.deepEqual(tuesday.correctionSuggestions, []);
});

test("applying the suggested correction makes the overnight day PRESENT with full minutes", async () => {
  const corrected = punch("b", "IN", "2026-11-17T04:00:00.000Z") as any;
  corrected.corrected_status = "OUT";
  corrected.correction_decision = "APPROVED";
  const db = mockDb({ schedules: nights, punches: [punch("a", "IN", "2026-11-16T20:00:00.000Z"), corrected] });
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-17");
  const monday = report.data.find((r: any) => r.date === "2026-11-16");
  assert.equal(monday.status, "PRESENT");
  assert.equal(monday.workedMinutes, 480);
  assert.deepEqual(monday.correctionSuggestions, []);
});

test("swapped overtime pair (two OVERTIME_IN in a row) suggests flipping the second", async () => {
  const db = mockDb({ schedules: [schedule(1, "08:00", "16:00")], punches: [
    punch("a", "IN", "2026-11-16T06:00:00.000Z"), punch("b", "OUT", "2026-11-16T14:00:00.000Z"),
    punch("c", "OVERTIME_IN", "2026-11-16T14:05:00.000Z"), punch("d", "OVERTIME_IN", "2026-11-16T17:00:00.000Z"),
  ]});
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-16");
  const row = report.data[0];
  assert.equal(row.needsReview, true);
  const suggestion = row.correctionSuggestions.find((s: any) => s.id === "d");
  assert.ok(suggestion, "expected a suggestion for the second OVERTIME_IN");
  assert.equal(suggestion.originalStatus, "OVERTIME_IN");
  assert.equal(suggestion.suggestedStatus, "OVERTIME_OUT");
});

test("swapped overtime pair (two OVERTIME_OUT in a row) suggests flipping the first", async () => {
  const db = mockDb({ schedules: [schedule(1, "08:00", "16:00")], punches: [
    punch("a", "IN", "2026-11-16T06:00:00.000Z"), punch("b", "OUT", "2026-11-16T14:00:00.000Z"),
    punch("c", "OVERTIME_OUT", "2026-11-16T14:05:00.000Z"), punch("d", "OVERTIME_OUT", "2026-11-16T17:00:00.000Z"),
  ]});
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-16");
  const suggestion = report.data[0].correctionSuggestions.find((s: any) => s.id === "c");
  assert.ok(suggestion, "expected a suggestion for the first OVERTIME_OUT");
  assert.equal(suggestion.suggestedStatus, "OVERTIME_IN");
});

test("a correct overtime pair produces no suggestion", async () => {
  const db = mockDb({ schedules: [schedule(1, "08:00", "16:00")], punches: [
    punch("a", "IN", "2026-11-16T06:00:00.000Z"), punch("b", "OUT", "2026-11-16T14:00:00.000Z"),
    punch("c", "OVERTIME_IN", "2026-11-16T14:05:00.000Z"), punch("d", "OVERTIME_OUT", "2026-11-16T17:00:00.000Z"),
  ]});
  const report = await buildAttendanceReport(db as any, "2026-11-16", "2026-11-16");
  assert.deepEqual(report.data[0].correctionSuggestions, []);
  assert.ok(report.data[0].overtimeMinutes > 0);
});
