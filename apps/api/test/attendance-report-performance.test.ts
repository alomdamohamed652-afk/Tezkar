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
  const punches = employees.flatMap((employee, index) => [
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
