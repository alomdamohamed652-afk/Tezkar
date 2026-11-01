import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const listSchema = z.object({ employeeId: z.string().uuid().optional() });
const updateSchema = z.object({
  status: z.enum(["PAID_PREVIOUSLY", "NEEDS_REVIEW"]),
  notes: z.string().trim().min(2).max(500),
  paymentDate: z.string().date().nullable().optional()
});

async function loadProductionSettlement(client: import("pg").PoolClient, productionEntryId: string) {
  const result = await client.query(`
    WITH canonical_allocations AS (
      SELECT es.worker_payment_id, es.employee_id, a.production_entry_id, a.amount
        FROM employee_earnings_settlement_allocations a
        JOIN employee_earnings_settlements es ON es.id=a.settlement_id
      UNION ALL
      SELECT wp.id, wp.employee_id, a.production_entry_id, a.amount
        FROM worker_payment_order_allocations a
        JOIN worker_payments wp ON wp.id=a.worker_payment_id
       WHERE NOT EXISTS (
         SELECT 1 FROM employee_earnings_settlements es
         JOIN employee_earnings_settlement_allocations sa ON sa.settlement_id=es.id
         WHERE es.worker_payment_id=wp.id
       )
      UNION ALL
      SELECT wp.id, wp.employee_id, a.production_entry_id, a.amount
        FROM worker_payment_allocations a
        JOIN worker_payments wp ON wp.id=a.worker_payment_id
       WHERE NOT EXISTS (
         SELECT 1 FROM employee_earnings_settlements es
         JOIN employee_earnings_settlement_allocations sa ON sa.settlement_id=es.id
         WHERE es.worker_payment_id=wp.id
       )
         AND NOT EXISTS (
           SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id
         )
    ),
    actual AS (
      SELECT COALESCE(SUM(ca.amount),0) AS amount
        FROM canonical_allocations ca
        JOIN production_entries p ON p.id=ca.production_entry_id
       WHERE ca.production_entry_id=$1
         AND ca.employee_id=p.employee_id
         AND p.status='APPROVED'
    )
    SELECT p.id,p.employee_id,p.code,p.status,p.work_date,
           COALESCE(p.total_earning_amount,p.earning_amount,0) AS earned,
           actual.amount AS actual_paid,
           m.id AS mark_id,m.status AS mark_status,m.amount_snapshot AS historical_paid,
           m.notes AS mark_notes,m.payment_date AS marked_payment_date,
           EXISTS (
             SELECT 1 FROM worker_payments wp
              WHERE wp.employee_id=p.employee_id
                AND wp.created_at::date>=p.work_date
                AND wp.gross_amount > COALESCE((
                  SELECT SUM(ca.amount) FROM canonical_allocations ca
                  WHERE ca.worker_payment_id=wp.id
                ),0)+0.009
           ) AS ambiguous_payment_evidence
      FROM production_entries p
      CROSS JOIN actual
      LEFT JOIN historical_production_settlement_marks m ON m.production_entry_id=p.id
     WHERE p.id=$1
  `, [productionEntryId]);
  return result.rows[0] ?? null;
}

export async function historicalProductionSettlementRoutes(app: FastifyInstance) {
  app.get("/api/worker-payments/historical-production-settlements", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    const parsed=listSchema.safeParse(request.query);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","اختيار العامل غير صحيح",422);
    const result=await pool.query(`
      WITH canonical_allocations AS (
        SELECT es.worker_payment_id,es.employee_id,a.production_entry_id,a.amount
          FROM employee_earnings_settlement_allocations a
          JOIN employee_earnings_settlements es ON es.id=a.settlement_id
        UNION ALL
        SELECT wp.id,wp.employee_id,a.production_entry_id,a.amount
          FROM worker_payment_order_allocations a
          JOIN worker_payments wp ON wp.id=a.worker_payment_id
         WHERE NOT EXISTS (SELECT 1 FROM employee_earnings_settlements es
           JOIN employee_earnings_settlement_allocations sa ON sa.settlement_id=es.id
           WHERE es.worker_payment_id=wp.id)
        UNION ALL
        SELECT wp.id,wp.employee_id,a.production_entry_id,a.amount
          FROM worker_payment_allocations a
          JOIN worker_payments wp ON wp.id=a.worker_payment_id
         WHERE NOT EXISTS (SELECT 1 FROM employee_earnings_settlements es
           JOIN employee_earnings_settlement_allocations sa ON sa.settlement_id=es.id
           WHERE es.worker_payment_id=wp.id)
           AND NOT EXISTS (SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
      ),
      actual AS (
        SELECT ca.production_entry_id, SUM(ca.amount) AS amount
          FROM canonical_allocations ca
          JOIN production_entries p ON p.id=ca.production_entry_id
         WHERE ca.employee_id=p.employee_id AND p.status='APPROVED'
         GROUP BY ca.production_entry_id
      )
      SELECT p.id AS production_entry_id,p.code AS production_code,p.employee_id,
             e.code AS employee_code,e.full_name AS employee_name,p.work_date,
             o.code AS order_code,o.order_name,s.name AS stage_name,
             COALESCE(p.total_earning_amount,p.earning_amount,0) AS earned_amount,
             COALESCE(a.amount,0) AS actual_paid_amount,
             CASE WHEN m.status='PAID_PREVIOUSLY' THEN m.amount_snapshot ELSE 0 END AS historical_paid_amount,
             GREATEST(0,COALESCE(p.total_earning_amount,p.earning_amount,0)
               -COALESCE(a.amount,0)
               -CASE WHEN m.status='PAID_PREVIOUSLY' THEN m.amount_snapshot ELSE 0 END) AS remaining_amount,
             m.id AS mark_id,m.status AS mark_status,m.notes AS mark_notes,m.payment_date,
             EXISTS (
               SELECT 1 FROM worker_payments wp
                WHERE wp.employee_id=p.employee_id AND wp.created_at::date>=p.work_date
                  AND wp.gross_amount > COALESCE((SELECT SUM(ca.amount) FROM canonical_allocations ca
                    WHERE ca.worker_payment_id=wp.id),0)+0.009
             ) AS ambiguous_payment_evidence,
             CASE
               WHEN COALESCE(a.amount,0)>=COALESCE(p.total_earning_amount,p.earning_amount,0)-0.009 THEN 'PAID_CONFIRMED'
               WHEN m.status='PAID_PREVIOUSLY' THEN 'PAID_HISTORICALLY'
               WHEN EXISTS (
                 SELECT 1 FROM worker_payments wp
                  WHERE wp.employee_id=p.employee_id AND wp.created_at::date>=p.work_date
                    AND wp.gross_amount > COALESCE((SELECT SUM(ca.amount) FROM canonical_allocations ca
                      WHERE ca.worker_payment_id=wp.id),0)+0.009
               ) THEN 'NEEDS_REVIEW'
               ELSE 'UNPAID'
             END AS classification
        FROM production_entries p
        JOIN employees e ON e.id=p.employee_id
        LEFT JOIN actual a ON a.production_entry_id=p.id
        LEFT JOIN historical_production_settlement_marks m ON m.production_entry_id=p.id
        LEFT JOIN order_stages os ON os.id=p.order_stage_id
        LEFT JOIN production_orders o ON o.id=os.order_id
        LEFT JOIN stages s ON s.id=os.stage_id
       WHERE p.status='APPROVED' AND ($1::uuid IS NULL OR p.employee_id=$1)
       ORDER BY p.work_date DESC,p.created_at DESC,p.id
    `,[parsed.data.employeeId??null]);
    return {data:result.rows};
  });

  app.patch("/api/worker-payments/historical-production-settlements/:productionEntryId", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    const productionEntryId=(request.params as {productionEntryId:string}).productionEntryId;
    const parsed=updateSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات التسوية التاريخية غير صحيحة؛ اكتب بيانًا واضحًا للحركة",422);
    return {data:await withTransaction(async(client)=>{
      const owner=await client.query("SELECT employee_id FROM production_entries WHERE id=$1",[productionEntryId]);
      if(!owner.rowCount) throw new AppError("PRODUCTION_NOT_FOUND","سجل الإنتاج غير موجود",404);
      const employeeId=String(owner.rows[0].employee_id);
      const lockedEmployee=await client.query("SELECT id FROM employees WHERE id=$1 FOR UPDATE",[employeeId]);
      if(!lockedEmployee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND","العامل غير موجود",404);
      const production=await client.query(
        "SELECT id,employee_id,status,COALESCE(total_earning_amount,earning_amount) AS earned FROM production_entries WHERE id=$1 FOR UPDATE",
        [productionEntryId]
      );
      if(!production.rowCount||production.rows[0].status!=="APPROVED")
        throw new AppError("PRODUCTION_NOT_APPROVED","لا يمكن تسوية سجل إنتاج غير معتمد",409);
      const before=await client.query("SELECT * FROM historical_production_settlement_marks WHERE production_entry_id=$1 FOR UPDATE",[productionEntryId]);
      if(before.rows[0]?.status==="PAID_PREVIOUSLY"&&parsed.data.status==="PAID_PREVIOUSLY")
        throw new AppError("HISTORICAL_SETTLEMENT_ALREADY_MARKED","سجل الإنتاج مُثبت كمدفوع تاريخيًا بالفعل؛ لن يتم تسجيله مرة ثانية",409);
      const evidence=await loadProductionSettlement(client,productionEntryId);
      if(parsed.data.status==="PAID_PREVIOUSLY"){
        if(Number(evidence.actual_paid)>0.009)
          throw new AppError("PRODUCTION_ALREADY_PAID","يوجد إثبات دفع مرتبط بسجل الإنتاج بالفعل؛ لن يتم إنشاء تسوية تاريخية مكررة",409);
        if(evidence.ambiguous_payment_evidence)
          throw new AppError("HISTORICAL_PAYMENT_NEEDS_REVIEW","توجد دفعة فعلية للعامل غير موزعة بالكامل وقد تكون مرتبطة بهذا السجل. راجع الدفعات القديمة أولًا؛ لم يتم تسجيل التسوية.",409);
      }
      const earned=Number(production.rows[0].earned);
      const amountSnapshot=parsed.data.status==="PAID_PREVIOUSLY"?Math.max(0,Math.round((earned-Number(evidence.actual_paid))*10000)/10000):0;
      if(parsed.data.status==="PAID_PREVIOUSLY"&&amountSnapshot<=0.0001)
        throw new AppError("NO_REMAINING_PRODUCTION_DUE","لا يوجد متبقٍ على سجل الإنتاج لتسويته",409);
      const saved=await client.query(`
        INSERT INTO historical_production_settlement_marks
          (employee_id,production_entry_id,amount_snapshot,status,payment_date,notes,marked_by,updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,now())
        ON CONFLICT(production_entry_id) DO UPDATE SET
          employee_id=EXCLUDED.employee_id,amount_snapshot=EXCLUDED.amount_snapshot,status=EXCLUDED.status,
          payment_date=EXCLUDED.payment_date,notes=EXCLUDED.notes,updated_by=EXCLUDED.updated_by,updated_at=now()
        RETURNING *
      `,[employeeId,productionEntryId,amountSnapshot,parsed.data.status,parsed.data.paymentDate??null,parsed.data.notes,request.user!.userId]);
      await writeAudit(client,{
        actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,
        action:parsed.data.status==="PAID_PREVIOUSLY"?"mark_historical_production_paid":"mark_historical_production_needs_review",
        module:"payments",entityType:"historical_production_settlement",entityId:saved.rows[0].id,
        beforeData:before.rows[0]??null,afterData:saved.rows[0],
        metadata:{employeeId,productionEntryId,amountSnapshot,financialMovementCreated:false,affectsEmployeeLedger:false,affectsAdvances:false},
        ipAddress:request.ip,userAgent:request.headers["user-agent"]??null
      });
      return saved.rows[0];
    })};
  });
}
