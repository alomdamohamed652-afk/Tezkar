import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const reportFilters = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  employeeId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  paymentStatus: z.enum(["PAID", "PARTIAL", "UNPAID", "UNALLOCATED"]).optional(),
  groupBy: z.enum(["none", "employee", "machine", "order", "shift", "day"]).default("none"),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  offset: z.coerce.number().int().min(0).default(0)
}).refine(value => !value.from || !value.to || value.from <= value.to, {
  message: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية"
});

const earningsFilters = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  employeeId: z.string().uuid().optional()
}).refine(value => !value.from || !value.to || value.from <= value.to, {
  message: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية"
});

export async function reportsRoutes(app: FastifyInstance) {
  app.get("/api/reports/production", { preHandler: [authenticateRequest, requirePermission("reports.view")] }, async request => {
    const parsed = reportFilters.safeParse(request.query);
    if (!parsed.success) throw new AppError("INVALID_REPORT_FILTERS", "فلاتر تقرير الإنتاج غير صحيحة", 422);
    const q = parsed.data;
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown, clause: (index: number) => string) => {
      params.push(value);
      where.push(clause(params.length));
    };

    if (q.from) add(q.from, i => `p.work_date >= $${i}::date`);
    if (q.to) add(q.to, i => `p.work_date <= $${i}::date`);
    if (q.employeeId) add(q.employeeId, i => `p.employee_id = $${i}`);
    if (q.orderId) add(q.orderId, i => `os.order_id = $${i}`);
    if (q.stageId) add(q.stageId, i => `p.stage_id = $${i}`);
    if (q.shiftId) add(q.shiftId, i => `p.shift_id = $${i}`);
    if (q.status) add(q.status, i => `p.status = $${i}`);
    else where.push("p.status <> 'CANCELLED'");
    let whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    if (q.paymentStatus) {
      const paymentPredicates: Record<string,string> = {
        PAID: "COALESCE(pa.paid_amount,0)+COALESCE(sa.paid_amount,0) >= COALESCE(p.total_earning_amount,p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0),0)-0.009",
        PARTIAL: "COALESCE(pa.paid_amount,0)+COALESCE(sa.paid_amount,0)>0.009 AND COALESCE(pa.paid_amount,0)+COALESCE(sa.paid_amount,0) < COALESCE(p.total_earning_amount,p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0),0)-0.009",
        UNALLOCATED: "COALESCE(unallocated.has_unallocated,FALSE)",
        UNPAID: "COALESCE(pa.paid_amount,0)+COALESCE(sa.paid_amount,0)<=0.009 AND NOT COALESCE(unallocated.has_unallocated,FALSE)"
      };
      where.push(paymentPredicates[q.paymentStatus]);
      whereSql = "WHERE " + where.join(" AND ");
    }

    // The count and totals use all of the same business filters (including payment state).
    // Keep joins for allocation-based filters so pagination cannot hide matching rows.
    const countJoins = `
      LEFT JOIN order_stages os ON os.id=p.order_stage_id
      LEFT JOIN LATERAL (SELECT SUM(a.amount) AS paid_amount FROM worker_payment_order_allocations a WHERE a.production_entry_id=p.id) pa ON TRUE
      LEFT JOIN LATERAL (SELECT SUM(a.amount) AS paid_amount FROM employee_earnings_settlement_allocations a WHERE a.production_entry_id=p.id) sa ON TRUE
      LEFT JOIN LATERAL (
        SELECT BOOL_OR(TRUE) AS has_unallocated FROM worker_payments wp
        JOIN accounting_expenses ae ON ae.idempotency_key=wp.idempotency_key
        WHERE wp.employee_id=p.employee_id AND os.order_id IS NOT NULL AND ae.order_id=os.order_id
          AND NOT EXISTS (SELECT 1 FROM worker_payment_order_allocations wpa WHERE wpa.worker_payment_id=wp.id)
      ) unallocated ON TRUE`;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM production_entries p ${countJoins} ${whereSql}`,
      params
    );
    const summaryResult = await pool.query(
      `SELECT COUNT(*)::int AS entries,COALESCE(SUM(p.quantity),0) AS quantity,
              COALESCE(SUM(p.hours_worked),0) AS hours,
              COALESCE(SUM(COALESCE(p.total_earning_amount,p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0))),0) AS earnings,
              COALESCE(SUM(p.bonus_amount),0) AS bonuses,COALESCE(SUM(p.deduction_amount),0) AS deductions,
              COALESCE(SUM(scrap.scrap_quantity),0) AS scrap
         FROM production_entries p LEFT JOIN order_stages os ON os.id=p.order_stage_id
         LEFT JOIN LATERAL (SELECT SUM(s.quantity) AS scrap_quantity FROM production_scrap_records s WHERE s.production_entry_id=p.id) scrap ON TRUE
        ${whereSql}`,
      params
    );

    const dataParams = [...params, q.limit, q.offset];
    const result = await pool.query(
      `SELECT p.id,to_char(p.work_date,'YYYY-MM-DD') AS work_date,p.code AS production_code,
              e.id AS employee_id,e.code AS employee_code,e.full_name AS employee_name,
              pr.code AS product_code,pr.name AS product_name,
              st.id AS stage_id,st.name AS stage_name,
              sh.id AS shift_id,sh.name AS shift_name,
              sle.full_name AS shift_leader_name,
              po.id AS order_id,po.code AS order_code,po.order_name AS order_name,
              pt.name AS machine_name,
              p.quantity,u.name AS unit_name,p.hours_worked,
              p.wage_type_code_snapshot AS wage_type_code,
              p.wage_type_method_snapshot AS wage_type_method,
              p.rate_snapshot,p.earning_amount AS base_earning_amount,
              p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0) AS earning_amount,
              p.bonus_amount,p.deduction_amount,
              COALESCE(adj.bonus_total,COALESCE(p.bonus_amount,0)) AS bonus_total,
              COALESCE(adj.deduction_total,COALESCE(p.deduction_amount,0)) AS deduction_total,
              COALESCE(p.total_earning_amount,p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0)) AS total_earning_amount,
              COALESCE(scrap.scrap_quantity,0) AS scrap_quantity,COALESCE(scrap.scrap_types,'') AS scrap_types,
              COALESCE(pa.paid_amount,0)+COALESCE(sa.paid_amount,0) AS paid_amount,
              GREATEST(COALESCE(p.total_earning_amount,p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0),0)-COALESCE(pa.paid_amount,0)-COALESCE(sa.paid_amount,0),0) AS remaining_amount,
              CASE WHEN COALESCE(pa.paid_amount,0)+COALESCE(sa.paid_amount,0) >= COALESCE(p.total_earning_amount,p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0),0)-0.009 THEN 'PAID'
                   WHEN COALESCE(pa.paid_amount,0)+COALESCE(sa.paid_amount,0)>0.009 THEN 'PARTIAL'
                   WHEN COALESCE(unallocated.has_unallocated,FALSE) THEN 'UNALLOCATED'
                   ELSE 'UNPAID' END AS payment_status,
              p.status
         FROM production_entries p
         JOIN employees e ON e.id=p.employee_id
         JOIN products pr ON pr.id=p.product_id
         JOIN stages st ON st.id=p.stage_id
         JOIN shifts sh ON sh.id=p.shift_id
         JOIN units u ON u.id=p.unit_id
         LEFT JOIN employees sle ON sle.id=p.shift_leader_employee_id
         LEFT JOIN order_stages os ON os.id=p.order_stage_id
         LEFT JOIN production_orders po ON po.id=os.order_id
         LEFT JOIN production_types pt ON pt.id=p.production_type_id
         LEFT JOIN LATERAL (
           SELECT SUM(s.quantity) AS scrap_quantity,string_agg(DISTINCT s.scrap_type,', ' ORDER BY s.scrap_type) AS scrap_types
             FROM production_scrap_records s WHERE s.production_entry_id=p.id
         ) scrap ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(a.amount) AS paid_amount FROM worker_payment_order_allocations a WHERE a.production_entry_id=p.id) pa ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(a.amount) AS paid_amount FROM employee_earnings_settlement_allocations a WHERE a.production_entry_id=p.id) sa ON TRUE
         LEFT JOIN LATERAL (
           SELECT BOOL_OR(TRUE) AS has_unallocated FROM worker_payments wp
             JOIN accounting_expenses ae ON ae.idempotency_key=wp.idempotency_key
            WHERE wp.employee_id=p.employee_id AND os.order_id IS NOT NULL AND ae.order_id=os.order_id
              AND NOT EXISTS (SELECT 1 FROM worker_payment_order_allocations wpa WHERE wpa.worker_payment_id=wp.id)
         ) unallocated ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(a.amount) FILTER (WHERE a.adjustment_type='BONUS') AS bonus_total,
                  SUM(a.amount) FILTER (WHERE a.adjustment_type='DEDUCTION') AS deduction_total
             FROM employee_earnings_adjustments a WHERE a.production_entry_id=p.id
         ) adj ON TRUE
        ${whereSql}
        ORDER BY p.work_date DESC,p.created_at DESC,p.id
        LIMIT $${params.length-1} OFFSET $${params.length}`,
      dataParams
    );

    const rows = result.rows;
    const count = Number(countResult.rows[0]?.total ?? 0);
    const groupExpression: Record<string,string> = {
      employee: "e.full_name",
      machine: "COALESCE(pt.name,pr.name)",
      order: "COALESCE(po.code || ' — ' || po.order_name,'بدون طلبية')",
      shift: "sh.name",
      day: "to_char(p.work_date,'YYYY-MM-DD')"
    };
    const groups = q.groupBy === "none" ? [] : (await pool.query(
      `SELECT ${groupExpression[q.groupBy]} AS group_name,COUNT(*)::int AS entries,
              COALESCE(SUM(p.quantity),0) AS quantity,
              COALESCE(SUM(COALESCE(p.total_earning_amount,p.earning_amount+COALESCE(p.bonus_amount,0)-COALESCE(p.deduction_amount,0))),0) AS earnings,
              COALESCE(SUM(p.hours_worked),0) AS hours
         FROM production_entries p JOIN employees e ON e.id=p.employee_id
         JOIN products pr ON pr.id=p.product_id JOIN shifts sh ON sh.id=p.shift_id
         LEFT JOIN order_stages os ON os.id=p.order_stage_id LEFT JOIN production_orders po ON po.id=os.order_id
         LEFT JOIN production_types pt ON pt.id=p.production_type_id
        ${whereSql}
        GROUP BY 1 ORDER BY 1`,
      params
    )).rows;
    return { data: rows, pagination: {total:count,limit:q.limit,offset:q.offset,hasMore:q.offset+rows.length<count},
      summary:summaryResult.rows[0], groups, meta:{from:q.from??null,to:q.to??null,generatedAt:new Date().toISOString(),groupBy:q.groupBy} };
  });

  app.get("/api/reports/employee-earnings", { preHandler: [authenticateRequest, requirePermission("reports.view")] }, async request => {
    const parsed = earningsFilters.safeParse(request.query);
    if (!parsed.success) throw new AppError("INVALID_REPORT_FILTERS", "فلاتر تقرير المستحقات غير صحيحة", 422);
    const q = parsed.data;
    const params: unknown[] = [];
    const ledgerConditions: string[] = ["l.employee_id=e.id"];
    const addLedgerFilter = (value: unknown, clause: (index: number) => string) => {
      params.push(value);
      ledgerConditions.push(clause(params.length));
    };
    if (q.from) addLedgerFilter(q.from, i => `l.created_at >= $${i}::date`);
    if (q.to) addLedgerFilter(q.to, i => `l.created_at < ($${i}::date + INTERVAL '1 day')`);
    let employeeWhere = "";
    if (q.employeeId) {
      params.push(q.employeeId);
      employeeWhere = `WHERE e.id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT e.id AS employee_id,e.code AS employee_code,e.full_name AS employee_name,e.full_name AS full_name,
              COALESCE(SUM(l.credit_amount) FILTER (WHERE l.advance_repayment_id IS NULL),0) AS earned,
              COALESCE(SUM(l.debit_amount),0) AS debited,
              COALESCE(SUM(l.credit_amount-l.debit_amount),0) AS balance,
              COUNT(l.id)::int AS ledger_entries,
              COUNT(l.id) FILTER (WHERE l.entry_type='PRODUCTION_APPROVAL')::int AS production_entries
         FROM employees e
         LEFT JOIN employee_earnings_ledger l ON ${ledgerConditions.join(" AND ")}
        ${employeeWhere}
        GROUP BY e.id,e.code,e.full_name
        ORDER BY e.full_name`,
      params
    );
    return { data: result.rows };
  });

  app.get("/api/reports/warehouse", { preHandler: [authenticateRequest, requirePermission("reports.view")] }, async () => {
    const r = await pool.query(`SELECT p.code AS product_code,p.name AS product_name,w.code AS warehouse_code,w.name AS warehouse_name,l.code AS location_code,l.name AS location_name,b.quantity,u.name AS unit_name,p.minimum_stock,(b.quantity < p.minimum_stock) AS below_minimum FROM stock_balances b JOIN products p ON p.id=b.product_id JOIN warehouses w ON w.id=b.warehouse_id JOIN warehouse_locations l ON l.id=b.location_id JOIN units u ON u.id=p.unit_id WHERE b.quantity>0 ORDER BY below_minimum DESC,p.name,w.name,l.code`);
    return { data: r.rows };
  });

  app.get("/api/reports/summary", { preHandler: [authenticateRequest, requirePermission("reports.view")] }, async () => {
    const [p,s,e,pay,a] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS entries,COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(COALESCE(total_earning_amount,earning_amount)),0) AS earnings FROM production_entries WHERE work_date=CURRENT_DATE AND status='APPROVED'"),
      pool.query("SELECT COUNT(*)::int AS lines,COALESCE(SUM(quantity),0) AS quantity FROM stock_balances WHERE quantity>0"),
      pool.query("SELECT COALESCE(SUM(credit_amount) FILTER(WHERE advance_repayment_id IS NULL),0) AS earned,COALESCE(SUM(debit_amount),0) AS debited,COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger"),
      pool.query("SELECT COUNT(*)::int AS count FROM payment_requests WHERE status='PENDING'"),
      pool.query("SELECT COUNT(*)::int AS count FROM advance_requests WHERE status='PENDING'")
    ]);
    return { data: { production:p.rows[0],stock:s.rows[0],earnings:e.rows[0],pendingPayments:pay.rows[0].count,pendingAdvances:a.rows[0].count } };
  });

  app.get("/api/audit-log", { preHandler: [authenticateRequest, requirePermission("audit.view")] }, async request => {
    const q = z.object({ limit:z.coerce.number().int().min(1).max(300).default(100) }).safeParse(request.query);
    if (!q.success) throw new AppError("INVALID_LIMIT", "عدد السجلات غير صحيح", 422);
    const r = await pool.query(`SELECT a.id,a.occurred_at,a.action,a.module,a.entity_type,a.entity_id,a.metadata,u.username,e.full_name AS employee_name,a.ip_address FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id LEFT JOIN employees e ON e.id=a.actor_employee_id ORDER BY a.occurred_at DESC LIMIT $1`, [q.data.limit]);
    return { data:r.rows };
  });
}