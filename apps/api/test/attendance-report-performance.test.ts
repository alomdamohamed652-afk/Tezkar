import assert from "node:assert/strict";
import test from "node:test";
import { buildAttendanceReport } from "../src/modules/attendance/attendance-report.service.js";

test("attendance report isolates each employee's punches after indexing report inputs", async () => {
  const employees = [
    { id: "employee-1", code: "EMP-1", full_name: "Employee One", device_code: "1", late_grace_minutes: 10, early_grace_minutes: 5 },
    { id: "employee-2", code: "EMP-2", full_name: "Employee Two", device_code: "2", late_grace_minutes: 10, early_grace_minutes: 5 },
  ];
  const schedules = employees.map(employee => ({
    employee_id: employee.id,
    weekday: 4,
    starts_at: "08:00",
    ends_at: "16:00",
    is_day_off: false,
    effective_from: "1900-01-01",
    effective_to: null,
  }));
  const punches = employees.flatMap(employee => [
    {
      id: employee.id + "-in",
      employee_id: employee.id,
      device_code: employee.device_code,
      punch_at: new Date(`2026-11-05T06:00:00.000Z`),
      corrected_punch_at: null,
      status: "IN",
      corrected_status: null,
      correction_decision: null,
      correction_note: null,
      correction_reviewed_by: null,
      correction_reviewed_at: null,
      verify_method: "FINGERPRINT",
      suspicious: false,
      review_status: "AUTO_ACCEPTED",
    },
    {
      id: employee.id + "-out",
      employee_id: employee.id,
      device_code: employee.device_code,
      punch_at: new Date(`2026-11-05T14:00:00.000Z`),
      corrected_punch_at: null,
      status: "OUT",
      corrected_status: null,
      correction_decision: null,
      correction_note: null,
      correction_reviewed_by: null,
      correction_reviewed_at: null,
      verify_method: "FINGERPRINT",
      suspicious: false,
      review_status: "AUTO_ACCEPTED",
    },
  ]);

  const db = {
    async query(sql: string) {
      if (sql.includes("FROM employees e")) return { rows: employees };
      if (sql.includes("FROM attendance_weekly_schedule_versions")) return { rows: schedules };
      if (sql.includes("FROM attendance_schedule_exceptions")) return { rows: [] };
      if (sql.includes("FROM attendance_punches")) return { rows: punches };
      if (sql.includes("FROM attendance_day_overrides")) return { rows: [] };
      if (sql.includes("FROM attendance_permission_requests")) return { rows: [] };
      throw new Error("Unexpected attendance report query: " + sql);
    },
  };

  const result = await buildAttendanceReport(db, "2026-11-05", "2026-11-05");
  assert.equal(result.data.length, 2);

  for (const employee of employees) {
    const row = result.data.find(item => item.employeeId === employee.id);
    assert.ok(row);
    assert.equal(row.punchCount, 2);
    assert.equal(row.workedMinutes, 480);
    assert.deepEqual(
      (row.punchTimeline as Array<{ id: string }>).map(punch => punch.id),
      [employee.id + "-in", employee.id + "-out"],
    );
  }
});

test("attendance report assigns next-day overnight checkout without stealing the next shift's punches", async () => {
  const employee = {
    id: "overnight-employee",
    code: "EMP-NIGHT",
    full_name: "Overnight Employee",
    device_code: "NIGHT-1",
    late_grace_minutes: 10,
    early_grace_minutes: 5,
  };
  const schedules = [
    {
      employee_id: employee.id,
      weekday: 4,
      starts_at: "22:00",
      ends_at: "06:00",
      is_day_off: false,
      effective_from: "1900-01-01",
      effective_to: null,
    },
    {
      employee_id: employee.id,
      weekday: 5,
      starts_at: "08:00",
      ends_at: "16:00",
      is_day_off: false,
      effective_from: "1900-01-01",
      effective_to: null,
    },
  ];
  const punch = (id: string, at: string, status: "IN" | "OUT") => ({
    id,
    employee_id: employee.id,
    device_code: employee.device_code,
    punch_at: new Date(at),
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
  });
  const punches = [
    punch("night-in", "2026-11-05T20:00:00.000Z", "IN"),
    punch("night-out", "2026-11-06T04:00:00.000Z", "OUT"),
    punch("day-in", "2026-11-06T06:00:00.000Z", "IN"),
    punch("day-out", "2026-11-06T14:00:00.000Z", "OUT"),
  ];
  const db = {
    async query(sql: string) {
      if (sql.includes("FROM employees e")) return { rows: [employee] };
      if (sql.includes("FROM attendance_weekly_schedule_versions")) return { rows: schedules };
      if (sql.includes("FROM attendance_schedule_exceptions")) return { rows: [] };
      if (sql.includes("FROM attendance_punches")) return { rows: punches };
      if (sql.includes("FROM attendance_day_overrides")) return { rows: [] };
      if (sql.includes("FROM attendance_permission_requests")) return { rows: [] };
      throw new Error("Unexpected attendance report query: " + sql);
    },
  };

  const result = await buildAttendanceReport(db, "2026-11-05", "2026-11-06");
  assert.equal(result.data.length, 2);
  const overnight = result.data.find(row => row.date === "2026-11-05");
  const daytime = result.data.find(row => row.date === "2026-11-06");
  assert.ok(overnight);
  assert.ok(daytime);
  assert.equal(overnight.punchCount, 2);
  assert.equal(overnight.workedMinutes, 480);
  assert.deepEqual(
    (overnight.punchTimeline as Array<{ id: string }>).map(item => item.id),
    ["night-in", "night-out"],
  );
  assert.equal(daytime.punchCount, 2);
  assert.equal(daytime.workedMinutes, 480);
  assert.deepEqual(
    (daytime.punchTimeline as Array<{ id: string }>).map(item => item.id),
    ["day-in", "day-out"],
  );
});


test("a report starting on a new month does not steal the prior month's overnight checkout", async () => {
  const employee = {
    id: "month-boundary-employee",
    code: "EMP-MONTH",
    full_name: "Month Boundary Employee",
    device_code: "MONTH-1",
    late_grace_minutes: 10,
    early_grace_minutes: 5,
    overnight_checkout_grace_minutes: 120,
  };
  const schedules = [
    {
      employee_id: employee.id,
      weekday: 6, // Saturday, 2026-10-31
      starts_at: "20:00",
      ends_at: "04:00",
      is_day_off: false,
      effective_from: "1900-01-01",
      effective_to: null,
    },
    {
      employee_id: employee.id,
      weekday: 0, // Sunday, 2026-11-01
      starts_at: "08:00",
      ends_at: "16:00",
      is_day_off: false,
      effective_from: "1900-01-01",
      effective_to: null,
    },
  ];
  const punch = (id: string, at: string, status: "IN" | "OUT") => ({
    id,
    employee_id: employee.id,
    device_code: employee.device_code,
    punch_at: new Date(at),
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
  });
  const punches = [
    punch("oct-night-in", "2026-10-31T18:00:00.000Z", "IN"),
    punch("nov-early-out", "2026-11-01T02:00:00.000Z", "OUT"),
    punch("nov-day-in", "2026-11-01T06:00:00.000Z", "IN"),
    punch("nov-day-out", "2026-11-01T14:00:00.000Z", "OUT"),
  ];
  const db = {
    async query(sql: string) {
      if (sql.includes("FROM employees e")) return { rows: [employee] };
      if (sql.includes("FROM attendance_weekly_schedule_versions")) return { rows: schedules };
      if (sql.includes("FROM attendance_schedule_exceptions")) return { rows: [] };
      if (sql.includes("FROM attendance_punches")) return { rows: punches };
      if (sql.includes("FROM attendance_day_overrides")) return { rows: [] };
      if (sql.includes("FROM attendance_permission_requests")) return { rows: [] };
      throw new Error("Unexpected attendance report query: " + sql);
    },
  };

  const result = await buildAttendanceReport(db, "2026-11-01", "2026-11-01");
  assert.equal(result.data.length, 1);
  const sunday = result.data[0];
  assert.equal(sunday.punchCount, 2);
  assert.equal(sunday.workedMinutes, 480);
  assert.deepEqual(
    (sunday.punchTimeline as Array<{ id: string }>).map(item => item.id),
    ["nov-day-in", "nov-day-out"],
  );
});


test("attendance report applies each employee's configured overnight checkout grace", async () => {
  const employee = {
    id: "configured-grace-employee",
    code: "EMP-GRACE",
    full_name: "Configured Grace Employee",
    device_code: "GRACE-1",
    late_grace_minutes: 10,
    early_grace_minutes: 5,
    overnight_checkout_grace_minutes: 0,
  };
  const schedules = [
    {
      employee_id: employee.id,
      weekday: 4,
      starts_at: "20:00",
      ends_at: "04:00",
      is_day_off: false,
      effective_from: "1900-01-01",
      effective_to: null,
    },
    {
      employee_id: employee.id,
      weekday: 5,
      starts_at: "08:00",
      ends_at: "16:00",
      is_day_off: false,
      effective_from: "1900-01-01",
      effective_to: null,
    },
  ];
  const punch = (id: string, at: string, status: "IN" | "OUT") => ({
    id,
    employee_id: employee.id,
    device_code: employee.device_code,
    punch_at: new Date(at),
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
  });
  const punches = [
    punch("grace-night-in", "2026-11-05T18:00:00.000Z", "IN"),
    punch("grace-night-out", "2026-11-06T03:30:00.000Z", "OUT"), // 05:30 Cairo, beyond zero grace
    punch("grace-day-in", "2026-11-06T06:00:00.000Z", "IN"),
    punch("grace-day-out", "2026-11-06T14:00:00.000Z", "OUT"),
  ];
  const db = {
    async query(sql: string) {
      if (sql.includes("FROM employees e")) return { rows: [employee] };
      if (sql.includes("FROM attendance_weekly_schedule_versions")) return { rows: schedules };
      if (sql.includes("FROM attendance_schedule_exceptions")) return { rows: [] };
      if (sql.includes("FROM attendance_punches")) return { rows: punches };
      if (sql.includes("FROM attendance_day_overrides")) return { rows: [] };
      if (sql.includes("FROM attendance_permission_requests")) return { rows: [] };
      throw new Error("Unexpected attendance report query: " + sql);
    },
  };

  const result = await buildAttendanceReport(db, "2026-11-05", "2026-11-06");
  const overnight = result.data.find(row => row.date === "2026-11-05");
  const daytime = result.data.find(row => row.date === "2026-11-06");
  assert.ok(overnight);
  assert.ok(daytime);
  assert.deepEqual(
    (overnight.punchTimeline as Array<{ id: string }>).map(item => item.id),
    ["grace-night-in"],
  );
  assert.deepEqual(
    (daytime.punchTimeline as Array<{ id: string }>).map(item => item.id),
    ["grace-night-out", "grace-day-in", "grace-day-out"],
  );
  assert.equal(daytime.needsReview, true);
});
