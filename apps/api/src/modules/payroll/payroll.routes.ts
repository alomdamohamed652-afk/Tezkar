import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { calculatePayrollDeduction } from "./payroll-calculation.js";

const monthSchema = z.string().regex(/^(?!0000-)\d{4}-(0[1-9]|1[0-2])$/, "الشهر يجب أن يكون بصيغة YYYY-MM وبشهر صحيح");
const profileSchema = z.object({
  employeeId: z.string().uuid(),
  monthlySalary: z.number().min(0).max(100000000),
  effectiveFrom: z.string().date(),
  notes: z.string().trim().max(1000).nullable().optional()
});
const adjustmentSchema = z.object({
  bonusAmount: z.number().min(0).max(100000000).optional(),
  deductionAmount: z.number().min(0).max(100000000).optional(),
  deductionMode: z.enum(["FIXED", "PERCENTAGE"]).optional(),
  deductionPercentage: z.number().positive().max(100).optional(),
  deductionBasis: z.enum(["BASE_SALARY", "BASE_PLUS_BONUS"]).optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});
const paymentSchema = z.object({
  amount: z.number().positive().max(100000000),
  paymentDate: z.string().date().optional(),
  paymentMethod: z.string().trim().max(80).nullable().optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});

export async function payrollRoutes(app: FastifyInstance) {
  app.get("/api/payroll/employees", { preHandler: [authenticateRequest, requirePermission("payroll.view")] }, async () => {
    const r = await pool.query(`SELECT e.id,e.code,e.full_name,e.department_id,d.name AS department_name,e.is_active,
      p.id AS salary_profile_id,p.monthly_salary,p.effective_from,p.effective_to,p.notes AS salary_notes
      FROM employees e LEFT JOIN departments d ON d.id=e.department_id
      LEFT JOIN employee_salary_profiles p ON p.employee_id=e.id AND p.effective_to IS NULL
      ORDER BY e.is_active DESC,e.full_name`);
    return { data: r.rows };
  });

  app.post("/api/payroll/salary-profiles", { preHandler: [authenticateRequest, requirePermission("payroll.manage")] }, async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات الراتب الأساسي غير صحيحة", 422);
    const result = await withTransaction(async client => {
      const employee = await client.query("SELECT id,full_name FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE", [parsed.data.employeeId]);
      if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 404);
      const previous = await client.query("SELECT * FROM employee_salary_profiles WHERE employee_id=$1 AND effective_to IS NULL FOR UPDATE", [parsed.data.employeeId]);
      const effectiveFrom = parsed.data.effectiveFrom;
      if (previous.rowCount) {
        const previousStart = String(previous.rows[0].effective_from).slice(0,10);
        if (effectiveFrom <= previousStart) throw new AppError("SALARY_DATE_INVALID", "تاريخ سريان الراتب الجديد يجب أن يكون بعد تاريخ بداية الراتب الحالي", 409);
        const end = new Date(effectiveFrom + "T00:00:00Z"); end.setUTCDate(end.getUTCDate()-1);
        await client.query("UPDATE employee_salary_profiles SET effective_to=$1 WHERE id=$2", [end.toISOString().slice(0,10), previous.rows[0].id]);
      }
      const inserted = await client.query("INSERT INTO employee_salary_profiles(employee_id,monthly_salary,effective_from,notes,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [parsed.data.employeeId,parsed.data.monthlySalary,effectiveFrom,parsed.data.notes??null,request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"set_salary",module:"payroll",entityType:"employee_salary_profile",entityId:inserted.rows[0].id,afterData:inserted.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.get("/api/payroll", { preHandler: [authenticateRequest, requirePermission("payroll.view")] }, async request => {
    const q = request.query as { month?: string };
    const parsedMonth = monthSchema.safeParse(q.month ?? new Date().toISOString().slice(0,7));
    if (!parsedMonth.success) throw new AppError("VALIDATION_ERROR", "حدد الشهر بصيغة YYYY-MM", 422);
    const month = parsedMonth.data + "-01";
    const period = await pool.query("SELECT * FROM payroll_periods WHERE period_month=$1::date", [month]);
    if (!period.rowCount) return { data: { period: null, items: [], totals: { employees: 0, net: 0, paid: 0, remaining: 0 } } };
    const items = await pool.query(`SELECT i.*,e.code AS employee_code,e.full_name AS employee_name,d.name AS department_name,
      COALESCE(p.paid,0) AS paid_amount,GREATEST(i.net_amount-COALESCE(p.paid,0),0) AS remaining_amount,
      COALESCE(ae.amount,0) AS recorded_expense_amount
      FROM payroll_items i JOIN employees e ON e.id=i.employee_id LEFT JOIN departments d ON d.id=e.department_id
      LEFT JOIN (SELECT payroll_item_id,SUM(amount) AS paid FROM payroll_payments GROUP BY payroll_item_id) p ON p.payroll_item_id=i.id
      LEFT JOIN accounting_expenses ae ON ae.id=i.accounting_expense_id
      WHERE i.period_id=$1 ORDER BY e.full_name`, [period.rows[0].id]);
    const totals = items.rows.reduce((a, x) => ({
      employees:a.employees+1,
      net:a.net+Number(x.net_amount),
      paid:a.paid+Number(x.paid_amount),
      remaining:a.remaining+Number(x.remaining_amount),
      recordedExpense:a.recordedExpense+Number(x.recorded_expense_amount),
      expenseDifference:a.expenseDifference+(Number(x.net_amount)-Number(x.recorded_expense_amount)),
      missingExpenseCount:a.missingExpenseCount+(Number(x.net_amount)>0&&!x.accounting_expense_id?1:0)
    }), { employees:0, net:0, paid:0, remaining:0, recordedExpense:0, expenseDifference:0, missingExpenseCount:0 });
    return { data: { period: period.rows[0], items: items.rows, totals } };
  });

  app.post("/api/payroll/generate", { preHandler: [authenticateRequest, requirePermission("payroll.generate")] }, async (request, reply) => {
    const parsed = z.object({ month: monthSchema }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "حدد شهرًا صحيحًا بصيغة YYYY-MM", 422);
    const month = parsed.data.month + "-01";
    const result = await withTransaction(async client => {
      const periodResult = await client.query("INSERT INTO payroll_periods(period_month,generated_by) VALUES($1::date,$2) ON CONFLICT(period_month) DO UPDATE SET period_month=EXCLUDED.period_month RETURNING *", [month,request.user!.userId]);
      const period = periodResult.rows[0];
      if (period.status !== "DRAFT") throw new AppError("PAYROLL_PERIOD_LOCKED", "الفترة معتمدة أو مغلقة ولا يمكن إعادة توليدها", 409);
      // Prorate each salary profile by the calendar days it was effective in this month.
      // The latest overlapping profile is retained as the item's reference profile, while
      // base_salary is the rounded sum across all profile periods for the employee.
      await client.query(`WITH month_bounds AS (
          SELECT $2::date AS month_start,
            ($2::date + INTERVAL '1 month - 1 day')::date AS month_end,
            (($2::date + INTERVAL '1 month')::date - $2::date)::numeric AS days_in_month
        ), profile_days AS (
          SELECT e.id AS employee_id, p.id AS profile_id, p.monthly_salary,
            GREATEST(p.effective_from,b.month_start) AS overlap_start,
            LEAST(COALESCE(p.effective_to,b.month_end),b.month_end) AS overlap_end,
            b.days_in_month
          FROM employees e
          JOIN employee_salary_profiles p ON p.employee_id=e.id
          CROSS JOIN month_bounds b
          WHERE e.is_active=TRUE
            AND p.effective_from <= b.month_end
            AND (p.effective_to IS NULL OR p.effective_to >= b.month_start)
        ), employee_totals AS (
          SELECT employee_id,
            (ARRAY_AGG(profile_id ORDER BY overlap_start DESC,profile_id DESC))[1] AS salary_profile_id,
            ROUND(SUM(monthly_salary * (overlap_end-overlap_start+1)::numeric / days_in_month),2) AS base_salary
          FROM profile_days
          GROUP BY employee_id
        )
        INSERT INTO payroll_items(period_id,employee_id,salary_profile_id,base_salary)
        SELECT $1,e.id,t.salary_profile_id,t.base_salary
        FROM employees e JOIN employee_totals t ON t.employee_id=e.id
        ON CONFLICT(period_id,employee_id) DO NOTHING`, [period.id,month]);
      const count = await client.query("SELECT COUNT(*)::int AS count FROM payroll_items WHERE period_id=$1", [period.id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"generate",module:"payroll",entityType:"payroll_period",entityId:period.id,afterData:{period,count:Number(count.rows[0].count)},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return { period, generatedItems:Number(count.rows[0].count) };
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/payroll/items/:id", { preHandler: [authenticateRequest, requirePermission("payroll.manage")] }, async request => {
    const id = (request.params as {id:string}).id;
    const parsed = adjustmentSchema.safeParse(request.body);
    if (!parsed.success || (parsed.data.bonusAmount===undefined && parsed.data.deductionAmount===undefined && parsed.data.deductionMode===undefined && parsed.data.deductionPercentage===undefined && parsed.data.deductionBasis===undefined && parsed.data.notes===undefined)) throw new AppError("VALIDATION_ERROR", "بيانات تعديل مسير الراتب غير صحيحة", 422);
    return withTransaction(async client => {
      const before = await client.query("SELECT i.*,p.status AS period_status FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id WHERE i.id=$1 FOR UPDATE OF i,p", [id]);
      if (!before.rowCount) throw new AppError("PAYROLL_ITEM_NOT_FOUND", "بند الراتب غير موجود", 404);
      if (before.rows[0].period_status !== "DRAFT") throw new AppError("PAYROLL_PERIOD_LOCKED", "لا يمكن تعديل مسير راتب معتمد", 409);
      const bonus = parsed.data.bonusAmount ?? Number(before.rows[0].bonus_amount);
      const deductionMode = parsed.data.deductionMode ?? before.rows[0].deduction_mode ?? "FIXED";
      const deductionBasis = parsed.data.deductionBasis ?? before.rows[0].deduction_basis ?? "BASE_SALARY";
      const deductionPercentage = parsed.data.deductionPercentage ?? (before.rows[0].deduction_percentage===null ? null : Number(before.rows[0].deduction_percentage));
      let deduction: number;
      if (deductionMode === "PERCENTAGE" && (deductionPercentage === null || deductionPercentage === undefined)) {
        throw new AppError("DEDUCTION_PERCENTAGE_REQUIRED", "حدد نسبة الخصم أولًا", 422);
      }
      try {
        deduction = calculatePayrollDeduction({
          baseSalary: Number(before.rows[0].base_salary),
          bonusAmount: bonus,
          mode: deductionMode,
          basis: deductionBasis,
          percentage: deductionPercentage,
          fixedAmount: parsed.data.deductionAmount ?? Number(before.rows[0].deduction_amount)
        }).amount;
      } catch {
        throw new AppError("DEDUCTION_PERCENTAGE_INVALID", "نسبة الخصم يجب أن تكون أكبر من صفر وحتى ١٠٠٪", 422);
      }
      if (Number(before.rows[0].base_salary)+bonus < deduction) throw new AppError("PAYROLL_NET_NEGATIVE", "الخصومات أكبر من إجمالي الراتب والمكافآت", 422);
      const updated = await client.query("UPDATE payroll_items SET bonus_amount=$1,deduction_amount=$2,deduction_mode=$3,deduction_percentage=$4,deduction_basis=$5,notes=$6 WHERE id=$7 RETURNING *",
        [bonus,deduction,deductionMode,deductionMode==="PERCENTAGE"?deductionPercentage:null,deductionBasis,parsed.data.notes===undefined?before.rows[0].notes:parsed.data.notes,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"adjust",module:"payroll",entityType:"payroll_item",entityId:id,beforeData:before.rows[0],afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return { data: updated.rows[0] };
    });
  });

  app.post("/api/payroll/periods/:id/approve", { preHandler: [authenticateRequest, requirePermission("payroll.approve")] }, async request => {
    const id = (request.params as {id:string}).id;
    const result = await withTransaction(async client => {
      const period = await client.query("SELECT * FROM payroll_periods WHERE id=$1 FOR UPDATE", [id]);
      if (!period.rowCount) throw new AppError("PAYROLL_PERIOD_NOT_FOUND", "فترة الرواتب غير موجودة", 404);
      if (period.rows[0].status !== "DRAFT") throw new AppError("PAYROLL_PERIOD_LOCKED", "الفترة ليست مسودة", 409);
      const count = await client.query("SELECT COUNT(*)::int AS count FROM payroll_items WHERE period_id=$1", [id]);
      if (!Number(count.rows[0].count)) throw new AppError("PAYROLL_EMPTY", "لا يوجد موظفون برواتب محددة في هذه الفترة", 409);
      const salaryItems = await client.query(`SELECT i.id,i.net_amount,i.accounting_expense_id,e.full_name
        FROM payroll_items i JOIN employees e ON e.id=i.employee_id WHERE i.period_id=$1 FOR UPDATE OF i`, [id]);
      for (const item of salaryItems.rows) {
        if (Number(item.net_amount) <= 0 || item.accounting_expense_id) continue;
        const expense = await client.query(`INSERT INTO accounting_expenses(order_id,category,description,amount,expense_date,payment_method,created_by)
          VALUES(NULL,'SALARIES',$1,$2,$3::date,'PAYROLL',$4) RETURNING id`,
          [`راتب شهر ${String(period.rows[0].period_month).slice(0,7)} - ${item.full_name}`,item.net_amount,period.rows[0].period_month,request.user!.userId]);
        await client.query("UPDATE payroll_items SET accounting_expense_id=$1 WHERE id=$2", [expense.rows[0].id,item.id]);
      }
      const updated = await client.query("UPDATE payroll_periods SET status='APPROVED',approved_by=$1,approved_at=now() WHERE id=$2 RETURNING *", [request.user!.userId,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"approve",module:"payroll",entityType:"payroll_period",entityId:id,beforeData:period.rows[0],afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return { data: result };
  });

  app.post("/api/payroll/items/:id/payments", { preHandler: [authenticateRequest, requirePermission("payroll.pay")] }, async (request, reply) => {
    const id = (request.params as {id:string}).id;
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات صرف الراتب غير صحيحة", 422);
    const result = await withTransaction(async client => {
      const item = await client.query("SELECT i.*,p.status AS period_status FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id WHERE i.id=$1 FOR UPDATE OF i,p", [id]);
      if (!item.rowCount) throw new AppError("PAYROLL_ITEM_NOT_FOUND", "بند الراتب غير موجود", 404);
      if (item.rows[0].period_status !== "APPROVED" && item.rows[0].period_status !== "CLOSED") throw new AppError("PAYROLL_NOT_APPROVED", "يجب اعتماد مسير الرواتب قبل الصرف", 409);
      const paid = await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM payroll_payments WHERE payroll_item_id=$1", [id]);
      const remaining = Number(item.rows[0].net_amount)-Number(paid.rows[0].amount);
      if (parsed.data.amount > remaining + 0.0001) throw new AppError("PAYROLL_OVERPAYMENT", "مبلغ الصرف أكبر من الراتب المتبقي", 409);
      const payment = await client.query("INSERT INTO payroll_payments(payroll_item_id,amount,payment_date,payment_method,reference,notes,paid_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id,parsed.data.amount,parsed.data.paymentDate??new Date().toISOString().slice(0,10),parsed.data.paymentMethod??null,parsed.data.reference??null,parsed.data.notes??null,request.user!.userId]);
      const newPaid = Number(paid.rows[0].amount)+parsed.data.amount;
      const status = newPaid >= Number(item.rows[0].net_amount)-0.0001 ? "PAID" : "PARTIAL";
      await client.query("UPDATE payroll_items SET status=$1 WHERE id=$2", [status,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"payment",module:"payroll",entityType:"payroll_payment",entityId:payment.rows[0].id,afterData:payment.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return { payment:payment.rows[0], paidAmount:newPaid, remainingAmount:Math.max(0,Number(item.rows[0].net_amount)-newPaid), status };
    });
    return reply.code(201).send({ data: result });
  });

  app.get("/api/payroll/items/:id/payments", { preHandler: [authenticateRequest, requirePermission("payroll.view")] }, async request => {
    const id = (request.params as {id:string}).id;
    const r = await pool.query("SELECT pp.*,u.username AS paid_by_username FROM payroll_payments pp JOIN users u ON u.id=pp.paid_by WHERE pp.payroll_item_id=$1 ORDER BY pp.payment_date DESC,pp.created_at DESC", [id]);
    return { data:r.rows };
  });
}
