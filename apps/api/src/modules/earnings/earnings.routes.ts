import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const filtersSchema = z.object({
  employeeId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

async function getOwnEmployeeId(userId: string) {
  const result = await pool.query("SELECT employee_id FROM users WHERE id=$1 AND is_active=TRUE", [userId]);
  const employeeId = result.rows[0]?.employee_id as string | null | undefined;
  if (!employeeId) throw new AppError("EMPLOYEE_LINK_REQUIRED", "الحساب غير مرتبط بملف موظف", 403);
  return employeeId;
}

export async function earningsRoutes(app: FastifyInstance) {
  app.get("/api/earnings/my-summary", {
    preHandler: [authenticateRequest, requirePermission("earnings.view_own", "own")]
  }, async (request) => {
    const employeeId = await getOwnEmployeeId(request.user!.userId);
    const result = await pool.query(
      "SELECT COALESCE(SUM(credit_amount),0) AS total_earned, COALESCE(SUM(debit_amount),0) AS total_paid, COALESCE(SUM(credit_amount - debit_amount),0) AS remaining FROM employee_earnings_ledger WHERE employee_id=$1",
      [employeeId]
    );
    return { data: result.rows[0] };
  });

  app.get("/api/earnings/my-ledger", {
    preHandler: [authenticateRequest, requirePermission("earnings.view_own", "own")]
  }, async (request) => {
    const employeeId = await getOwnEmployeeId(request.user!.userId);
    const q = filtersSchema.safeParse(request.query);
    if (!q.success) throw new AppError("VALIDATION_ERROR", "فلاتر سجل المستحقات غير صحيحة", 422);

    const params: unknown[] = [employeeId];
    const where = ["l.employee_id=$1"];
    if (q.data.from) { params.push(q.data.from); where.push("l.created_at >= $" + params.length + "::date"); }
    if (q.data.to) { params.push(q.data.to); where.push("l.created_at < ($" + params.length + "::date + INTERVAL '1 day')"); }
    params.push(q.data.limit);

    const result = await pool.query(
      "SELECT l.id,l.code,l.entry_type,l.credit_amount,l.debit_amount,l.notes,l.created_at,p.code AS production_code,w.code AS payment_code FROM employee_earnings_ledger l LEFT JOIN production_entries p ON p.id=l.production_entry_id LEFT JOIN worker_payments w ON w.id=l.worker_payment_id WHERE " + where.join(" AND ") + " ORDER BY l.created_at DESC,l.id DESC LIMIT $" + params.length,
      params
    );
    return { data: result.rows };
  });

  app.get("/api/earnings", {
    preHandler: [authenticateRequest, requirePermission("earnings.view")]
  }, async (request) => {
    const q = filtersSchema.safeParse(request.query);
    if (!q.success) throw new AppError("VALIDATION_ERROR", "فلاتر سجل المستحقات غير صحيحة", 422);

    const params: unknown[] = [];
    const where: string[] = [];
    if (q.data.employeeId) { params.push(q.data.employeeId); where.push("l.employee_id=$" + params.length); }
    if (q.data.from) { params.push(q.data.from); where.push("l.created_at >= $" + params.length + "::date"); }
    if (q.data.to) { params.push(q.data.to); where.push("l.created_at < ($" + params.length + "::date + INTERVAL '1 day')"); }
    params.push(q.data.limit);

    const result = await pool.query(
      "SELECT l.id,l.code,l.employee_id,e.code AS employee_code,e.full_name AS employee_name,l.entry_type,l.credit_amount,l.debit_amount,l.notes,l.created_at,p.code AS production_code,w.code AS payment_code FROM employee_earnings_ledger l JOIN employees e ON e.id=l.employee_id LEFT JOIN production_entries p ON p.id=l.production_entry_id LEFT JOIN worker_payments w ON w.id=l.worker_payment_id " + (where.length ? "WHERE " + where.join(" AND ") : "") + " ORDER BY l.created_at DESC,l.id DESC LIMIT $" + params.length,
      params
    );
    return { data: result.rows };
  });
}
