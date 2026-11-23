import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { buildAttendanceReport } from "../attendance/attendance-report.service.js";

// Every route here is scoped to the signed-in user's own employee file.
// The employee id always comes from the session, never from the request.
function ownEmployeeId(request: { user: { employeeId: string | null } | null }): string {
  const employeeId = request.user?.employeeId;
  if (!employeeId) throw new AppError("EMPLOYEE_LINK_REQUIRED", "حسابك غير مرتبط بملف موظف؛ اطلب من الإدارة ربط الحساب", 403);
  return employeeId;
}

const rangeSchema = z.object({ from: z.string().date(), to: z.string().date() });

export async function selfServiceRoutes(app: FastifyInstance) {
  app.get("/api/me/attendance", { preHandler: [authenticateRequest, requirePermission("attendance.view_own", "own")] }, async request => {
    const employeeId = ownEmployeeId(request);
    const range = rangeSchema.safeParse(request.query);
    if (!range.success || range.data.to < range.data.from) throw new AppError("VALIDATION_ERROR", "حدد فترة صحيحة", 422);
    const days = (new Date(range.data.to + "T00:00:00Z").getTime() - new Date(range.data.from + "T00:00:00Z").getTime()) / 86400000 + 1;
    if (days > 62) throw new AppError("DATE_RANGE_TOO_LARGE", "الفترة القصوى 62 يومًا", 422);
    const report = await buildAttendanceReport(pool, range.data.from, range.data.to, true, employeeId);
    const punches = await pool.query(
      `SELECT COALESCE(corrected_punch_at,punch_at) AS punch_at,COALESCE(corrected_status,status) AS status,verify_method
         FROM attendance_punches
        WHERE employee_id=$1 AND review_status<>'REJECTED'
          AND (COALESCE(corrected_punch_at,punch_at) AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2::date AND $3::date
        ORDER BY COALESCE(corrected_punch_at,punch_at) DESC LIMIT 600`,
      [employeeId, range.data.from, range.data.to]
    );
    // Only fields the employee needs; no review notes, device codes or other staff data.
    const rows = (report.data as Record<string, unknown>[]).map(r => ({
      date: r.date, status: r.status, isDayOff: r.isDayOff,
      scheduledStart: r.scheduledStart, scheduledEnd: r.scheduledEnd,
      firstIn: r.firstIn, lastOut: r.lastOut,
      workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes, earlyMinutes: r.earlyMinutes,
      overtimeMinutes: r.overtimeMinutes, permissionMinutes: r.permissionMinutes ?? 0,
      outsideSchedule: r.outsideSchedule ?? false
    }));
    return { data: { days: rows, punches: punches.rows } };
  });

  app.get("/api/me/schedule", { preHandler: [authenticateRequest, requirePermission("attendance.view_own", "own")] }, async request => {
    const employeeId = ownEmployeeId(request);
    const weekly = await pool.query(
      `SELECT DISTINCT ON (weekday) weekday,starts_at::text AS starts_at,ends_at::text AS ends_at,is_day_off
         FROM attendance_weekly_schedule_versions
        WHERE employee_id=$1 AND effective_from<=(now() AT TIME ZONE 'Africa/Cairo')::date
          AND (effective_to IS NULL OR effective_to>=(now() AT TIME ZONE 'Africa/Cairo')::date)
        ORDER BY weekday,effective_from DESC`, [employeeId]);
    const exceptions = await pool.query(
      `SELECT start_date::text AS start_date,end_date::text AS end_date,starts_at::text AS starts_at,ends_at::text AS ends_at,is_day_off,note
         FROM attendance_schedule_exceptions
        WHERE employee_id=$1 AND end_date>=((now() AT TIME ZONE 'Africa/Cairo')::date-30)
        ORDER BY start_date LIMIT 100`, [employeeId]);
    return { data: { weekly: weekly.rows, exceptions: exceptions.rows } };
  });

  // Approved payslips only; voided adjustment lines are never shown to the employee.
  app.get("/api/me/payslips", { preHandler: [authenticateRequest, requirePermission("payroll.view_own", "own")] }, async request => {
    const employeeId = ownEmployeeId(request);
    const items = await pool.query(
      `SELECT i.id,p.period_month::text AS period_month,p.status AS period_status,i.base_salary,i.bonus_amount,i.deduction_amount,
              i.advance_repayment_amount,i.net_amount,i.status,i.notes,
              e.code AS employee_code,e.full_name AS employee_name,d.name AS department_name,
              COALESCE((SELECT SUM(pp.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='PAYROLL_PAYMENT' AND rl.source_id=pp.id),0)) FROM payroll_payments pp WHERE pp.payroll_item_id=i.id),0) AS paid_amount,
              COALESCE((SELECT json_agg(json_build_object('id',l.id,'line_type',l.line_type,'description',l.description,'amount',l.amount,'notes',l.notes) ORDER BY l.created_at,l.id)
                          FROM payroll_adjustment_lines l WHERE l.payroll_item_id=i.id AND l.status='ACTIVE'),'[]'::json) AS lines
         FROM payroll_items i
         JOIN payroll_periods p ON p.id=i.period_id
         JOIN employees e ON e.id=i.employee_id
         LEFT JOIN departments d ON d.id=e.department_id
        WHERE i.employee_id=$1 AND p.status IN ('APPROVED','CLOSED')
        ORDER BY p.period_month DESC LIMIT 12`, [employeeId]);
    const data = items.rows.map(r => ({ ...r, remaining_amount: Math.max(Number(r.net_amount) - Number(r.paid_amount), 0) }));
    return { data };
  });

  // Own-scoped salary explanation: the frozen attendance calculation behind the employee's own
  // approved slip (same data the printed slip summarizes). Never exposes other employees.
  app.get("/api/me/payslips/:id/calculation", { preHandler: [authenticateRequest, requirePermission("payroll.view_own", "own")] }, async request => {
    const employeeId = ownEmployeeId(request);
    const id = (request.params as { id: string }).id;
    const item = await pool.query(
      `SELECT i.id FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id
        WHERE i.id=$1 AND i.employee_id=$2 AND p.status IN ('APPROVED','CLOSED')`, [id, employeeId]);
    if (!item.rowCount) throw new AppError("PAYROLL_ITEM_NOT_FOUND", "بند المرتب غير موجود أو لم يُعتمد بعد", 404);
    const calculation = await pool.query("SELECT calculation_data,captured_at FROM payroll_attendance_calculations WHERE payroll_item_id=$1", [id]);
    return { data: { calculation: calculation.rows[0]?.calculation_data ?? null, capturedAt: calculation.rows[0]?.captured_at ?? null } };
  });
}
