import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { hashPassword, verifyPassword } from "../auth/auth.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const listSchema = z.object({ employeeId: z.string().uuid().optional() });
const updateSchema = z.object({
  status: z.enum(["PAID_PREVIOUSLY", "NEEDS_REVIEW"]),
  confirmAmbiguousPayment: z.boolean().optional(),
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
        unlinked_allocation_conflicts AS (
      SELECT DISTINCT es.employee_id,sa.production_entry_id
        FROM employee_earnings_settlements es
        JOIN employee_earnings_settlement_allocations sa ON sa.settlement_id=es.id
        JOIN production_entries p ON p.id=sa.production_entry_id AND p.employee_id=es.employee_id
       WHERE es.worker_payment_id IS NULL
         AND (
           EXISTS(SELECT 1 FROM worker_payment_order_allocations oa JOIN worker_payments wp ON wp.id=oa.worker_payment_id
             WHERE wp.employee_id=es.employee_id AND oa.production_entry_id=sa.production_entry_id AND ABS(oa.amount-sa.amount)<=0.009)
           OR EXISTS(SELECT 1 FROM worker_payment_allocations la JOIN worker_payments wp ON wp.id=la.worker_payment_id
             WHERE wp.employee_id=es.employee_id AND la.production_entry_id=sa.production_entry_id AND ABS(la.amount-sa.amount)<=0.009)
         )
    ),
actual AS (
      SELECT COALESCE(SUM(ca.amount),0) AS amount
        FROM canonical_allocations ca
        JOIN production_entries p ON p.id=ca.production_entry_id
       WHERE ca.production_entry_id=$1
         AND ca.employee_id=p.employee_id
         AND p.status='APPROVED'
         AND NOT EXISTS(SELECT 1 FROM unlinked_allocation_conflicts uac
           WHERE uac.employee_id=ca.employee_id AND uac.production_entry_id=ca.production_entry_id)
    ),
    source_conflicts AS (
      SELECT wp.id,
        (
          (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id)
           AND EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
           AND (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND oa.production_entry_id=sa.production_entry_id AND oa.amount IS NOT DISTINCT FROM sa.amount))
             OR EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND sa.production_entry_id=oa.production_entry_id AND sa.amount IS NOT DISTINCT FROM oa.amount))))
          OR (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id)
           AND EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id)
           AND (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND la.production_entry_id=sa.production_entry_id AND la.amount IS NOT DISTINCT FROM sa.amount))
             OR EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND sa.production_entry_id=la.production_entry_id AND sa.amount IS NOT DISTINCT FROM la.amount))))
          OR (EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
           AND EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id)
           AND (EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND la.production_entry_id=oa.production_entry_id AND la.amount IS NOT DISTINCT FROM oa.amount))
             OR EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND oa.production_entry_id=la.production_entry_id AND oa.amount IS NOT DISTINCT FROM la.amount))))
        ) AS has_source_conflicts
      FROM worker_payments wp
    ),
    payment_coverage AS (
      SELECT wp.id,wp.employee_id,wp.created_at,
        LEAST(wp.gross_amount,GREATEST(0,
          COALESCE((SELECT SUM(COALESCE(pe.total_earning_amount,pe.earning_amount))
            FROM production_entries pe
            WHERE pe.employee_id=wp.employee_id AND pe.status='APPROVED' AND pe.work_date<=wp.created_at::date),0)
          -COALESCE((SELECT SUM(ca.amount) FROM canonical_allocations ca
            JOIN worker_payments prior ON prior.id=ca.worker_payment_id
            WHERE prior.employee_id=wp.employee_id
              AND (prior.created_at<wp.created_at OR (prior.created_at=wp.created_at AND prior.id<wp.id))),0)
        )) AS expected_production_amount,
        COALESCE((SELECT SUM(ca.amount) FROM canonical_allocations ca
          JOIN production_entries valid_pe ON valid_pe.id=ca.production_entry_id
          WHERE ca.worker_payment_id=wp.id AND ca.employee_id=valid_pe.employee_id
            AND valid_pe.status='APPROVED'),0) AS allocated_production_amount,
        EXISTS(SELECT 1 FROM canonical_allocations invalid_ca
          LEFT JOIN production_entries invalid_pe ON invalid_pe.id=invalid_ca.production_entry_id
          WHERE invalid_ca.worker_payment_id=wp.id
            AND (invalid_pe.id IS NULL OR invalid_ca.employee_id IS DISTINCT FROM invalid_pe.employee_id
              OR invalid_pe.status<>'APPROVED')) AS has_invalid_allocations,
        COALESCE((SELECT sc.has_source_conflicts FROM source_conflicts sc WHERE sc.id=wp.id),false) AS has_source_conflicts
      FROM worker_payments wp
    )
    SELECT p.id,p.employee_id,p.code,p.status,p.work_date,
           COALESCE(p.total_earning_amount,p.earning_amount,0) AS earned,
           actual.amount AS actual_paid,
           m.id AS mark_id,m.status AS mark_status,m.amount_snapshot AS historical_paid,
           m.notes AS mark_notes,m.payment_date AS marked_payment_date,
           EXISTS (
             SELECT 1 FROM payment_coverage pc
              WHERE pc.employee_id=p.employee_id
                AND pc.created_at::date>=p.work_date
                AND (pc.expected_production_amount>pc.allocated_production_amount+0.009 OR pc.has_invalid_allocations OR pc.has_source_conflicts
                  OR EXISTS(SELECT 1 FROM unlinked_allocation_conflicts uac WHERE uac.employee_id=pc.employee_id AND uac.production_entry_id=p.id))
           ) AS ambiguous_payment_evidence,
           EXISTS (
             SELECT 1 FROM payment_coverage pc
              WHERE pc.employee_id=p.employee_id
                AND pc.created_at::date>=p.work_date
                AND (
                  (pc.has_invalid_allocations OR pc.has_source_conflicts)
                  AND (
                    EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa
                      JOIN employee_earnings_settlements es ON es.id=sa.settlement_id
                      WHERE es.worker_payment_id=pc.id AND sa.production_entry_id=p.id)
                    OR EXISTS(SELECT 1 FROM worker_payment_order_allocations oa
                      WHERE oa.worker_payment_id=pc.id AND oa.production_entry_id=p.id)
                    OR EXISTS(SELECT 1 FROM worker_payment_allocations la
                      WHERE la.worker_payment_id=pc.id AND la.production_entry_id=p.id)
                  )
                  OR EXISTS(SELECT 1 FROM unlinked_allocation_conflicts uac
                    WHERE uac.employee_id=pc.employee_id AND uac.production_entry_id=p.id)
                )
           ) AS hard_payment_conflict
      FROM production_entries p
      CROSS JOIN actual
      LEFT JOIN historical_production_settlement_marks m ON m.production_entry_id=p.id
     WHERE p.id=$1
  `, [productionEntryId]);
  return result.rows[0] ?? null;
}

const closurePasswordSchema=z.object({password:z.string().min(10).max(200)});

async function assertClosurePassword(request: {headers: Record<string, any>; ip: string}) {
  const supplied=request.headers["x-production-closure-password"];
  const password=Array.isArray(supplied)?supplied[0]:supplied;
  if(typeof password!=="string"||!password) throw new AppError("CLOSURE_PASSWORD_REQUIRED","أدخل كلمة مرور قسم إقفال المستحقات",401);
  const attempts=await pool.query(
    "SELECT failed_attempts,locked_until FROM employee_production_closure_access_attempts WHERE ip_address=$1",
    [request.ip]
  );
  if(attempts.rows[0]?.locked_until && new Date(attempts.rows[0].locked_until).getTime()>Date.now())
    throw new AppError("CLOSURE_PASSWORD_RATE_LIMITED","تم إيقاف المحاولات مؤقتًا بسبب تكرار كلمة المرور الخاطئة. حاول بعد 15 دقيقة.",429);
  const result=await pool.query("SELECT password_hash FROM employee_production_closure_access WHERE id=1");
  const stored=result.rows[0]?.password_hash as string|undefined;
  if(!stored) throw new AppError("CLOSURE_PASSWORD_NOT_CONFIGURED","لم يتم إعداد كلمة مرور القسم بعد. اطلب من مدير النظام إعدادها.",409);
  if(!verifyPassword(password,stored)){
    await pool.query(`
      INSERT INTO employee_production_closure_access_attempts(ip_address,failed_attempts,updated_at)
      VALUES($1,1,now())
      ON CONFLICT(ip_address) DO UPDATE SET
        failed_attempts=CASE
          WHEN employee_production_closure_access_attempts.locked_until IS NOT NULL
            AND employee_production_closure_access_attempts.locked_until<=now() THEN 1
          ELSE employee_production_closure_access_attempts.failed_attempts+1 END,
        locked_until=CASE
          WHEN (CASE
            WHEN employee_production_closure_access_attempts.locked_until IS NOT NULL
              AND employee_production_closure_access_attempts.locked_until<=now() THEN 1
            ELSE employee_production_closure_access_attempts.failed_attempts+1 END)>=5
          THEN now()+interval '15 minutes' ELSE NULL END,
        updated_at=now()
    `,[request.ip]);
    throw new AppError("INVALID_CLOSURE_PASSWORD","كلمة مرور القسم غير صحيحة",401);
  }
  await pool.query("DELETE FROM employee_production_closure_access_attempts WHERE ip_address=$1",[request.ip]);
}

export async function historicalProductionSettlementRoutes(app: FastifyInstance) {
  app.get("/api/worker-payments/employee-production-closures/access-status", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async () => {
    const result=await pool.query("SELECT 1 FROM employee_production_closure_access WHERE id=1");
    return {data:{configured:Boolean(result.rowCount)}};
  });

  app.post("/api/worker-payments/employee-production-closures/access-setup", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    if(!request.user?.roleCodes?.some(role=>["admin","manager","owner"].includes(role.toLowerCase())))
      throw new AppError("FORBIDDEN","إعداد كلمة مرور القسم متاح لمدير النظام فقط",403);
    const parsed=closurePasswordSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","كلمة المرور يجب ألا تقل عن 10 أحرف",422);
    await withTransaction(async(client)=>{
      const existing=await client.query("SELECT id FROM employee_production_closure_access WHERE id=1 FOR UPDATE");
      if(existing.rowCount) throw new AppError("CLOSURE_PASSWORD_ALREADY_CONFIGURED","كلمة مرور القسم تم إعدادها بالفعل. استخدم تغيير كلمة المرور.",409);
      await client.query("INSERT INTO employee_production_closure_access(id,password_hash,updated_by) VALUES(1,$1,$2)",[hashPassword(parsed.data.password),request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"production_closure_password_created",module:"payments",entityType:"system_setting",entityId:null,metadata:{settingKey:"employee_production_closure_access",passwordStoredAsHash:true},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
    });
    return {data:{success:true}};
  });

  app.post("/api/worker-payments/employee-production-closures/access-change", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    if(!request.user?.roleCodes?.some(role=>["admin","manager","owner"].includes(role.toLowerCase())))
      throw new AppError("FORBIDDEN","تغيير كلمة مرور القسم متاح لمدير النظام فقط",403);
    const parsed=z.object({currentPassword:z.string().min(1).max(200),newPassword:z.string().min(10).max(200)}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات تغيير كلمة المرور غير صحيحة",422);
    await withTransaction(async(client)=>{
      const current=await client.query("SELECT password_hash FROM employee_production_closure_access WHERE id=1 FOR UPDATE");
      if(!current.rowCount||!verifyPassword(parsed.data.currentPassword,current.rows[0].password_hash))
        throw new AppError("INVALID_CLOSURE_PASSWORD","كلمة المرور الحالية غير صحيحة",401);
      await client.query("UPDATE employee_production_closure_access SET password_hash=$1,updated_by=$2,updated_at=now() WHERE id=1",[hashPassword(parsed.data.newPassword),request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"production_closure_password_changed",module:"payments",entityType:"system_setting",entityId:null,metadata:{settingKey:"employee_production_closure_access",passwordStoredAsHash:true},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
    });
    return {data:{success:true}};
  });

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
          unlinked_allocation_conflicts AS (
      SELECT DISTINCT es.employee_id,sa.production_entry_id
        FROM employee_earnings_settlements es
        JOIN employee_earnings_settlement_allocations sa ON sa.settlement_id=es.id
        JOIN production_entries p ON p.id=sa.production_entry_id AND p.employee_id=es.employee_id
       WHERE es.worker_payment_id IS NULL
         AND (
           EXISTS(SELECT 1 FROM worker_payment_order_allocations oa JOIN worker_payments wp ON wp.id=oa.worker_payment_id
             WHERE wp.employee_id=es.employee_id AND oa.production_entry_id=sa.production_entry_id AND ABS(oa.amount-sa.amount)<=0.009)
           OR EXISTS(SELECT 1 FROM worker_payment_allocations la JOIN worker_payments wp ON wp.id=la.worker_payment_id
             WHERE wp.employee_id=es.employee_id AND la.production_entry_id=sa.production_entry_id AND ABS(la.amount-sa.amount)<=0.009)
         )
    ),
actual AS (
        SELECT ca.production_entry_id, SUM(ca.amount) AS amount
          FROM canonical_allocations ca
          JOIN production_entries p ON p.id=ca.production_entry_id
         WHERE ca.employee_id=p.employee_id AND p.status='APPROVED'
           AND NOT EXISTS(SELECT 1 FROM unlinked_allocation_conflicts uac
             WHERE uac.employee_id=ca.employee_id AND uac.production_entry_id=ca.production_entry_id)
         GROUP BY ca.production_entry_id
      ),
    source_conflicts AS (
      SELECT wp.id,
        (
          (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id)
           AND EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
           AND (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND oa.production_entry_id=sa.production_entry_id AND oa.amount IS NOT DISTINCT FROM sa.amount))
             OR EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND sa.production_entry_id=oa.production_entry_id AND sa.amount IS NOT DISTINCT FROM oa.amount))))
          OR (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id)
           AND EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id)
           AND (EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND la.production_entry_id=sa.production_entry_id AND la.amount IS NOT DISTINCT FROM sa.amount))
             OR EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlement_allocations sa JOIN employee_earnings_settlements es ON es.id=sa.settlement_id WHERE es.worker_payment_id=wp.id AND sa.production_entry_id=la.production_entry_id AND sa.amount IS NOT DISTINCT FROM la.amount))))
          OR (EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
           AND EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id)
           AND (EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND la.production_entry_id=oa.production_entry_id AND la.amount IS NOT DISTINCT FROM oa.amount))
             OR EXISTS(SELECT 1 FROM worker_payment_allocations la WHERE la.worker_payment_id=wp.id AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id AND oa.production_entry_id=la.production_entry_id AND oa.amount IS NOT DISTINCT FROM la.amount))))
        ) AS has_source_conflicts
      FROM worker_payments wp
    ),
    payment_coverage AS (
      SELECT wp.id,wp.employee_id,wp.created_at,
        LEAST(wp.gross_amount,GREATEST(0,
          COALESCE((SELECT SUM(COALESCE(pe.total_earning_amount,pe.earning_amount))
            FROM production_entries pe
            WHERE pe.employee_id=wp.employee_id AND pe.status='APPROVED' AND pe.work_date<=wp.created_at::date),0)
          -COALESCE((SELECT SUM(ca.amount) FROM canonical_allocations ca
            JOIN worker_payments prior ON prior.id=ca.worker_payment_id
            WHERE prior.employee_id=wp.employee_id
              AND (prior.created_at<wp.created_at OR (prior.created_at=wp.created_at AND prior.id<wp.id))),0)
        )) AS expected_production_amount,
        COALESCE((SELECT SUM(ca.amount) FROM canonical_allocations ca
          JOIN production_entries valid_pe ON valid_pe.id=ca.production_entry_id
          WHERE ca.worker_payment_id=wp.id AND ca.employee_id=valid_pe.employee_id
            AND valid_pe.status='APPROVED'),0) AS allocated_production_amount,
        EXISTS(SELECT 1 FROM canonical_allocations invalid_ca
          LEFT JOIN production_entries invalid_pe ON invalid_pe.id=invalid_ca.production_entry_id
          WHERE invalid_ca.worker_payment_id=wp.id
            AND (invalid_pe.id IS NULL OR invalid_ca.employee_id IS DISTINCT FROM invalid_pe.employee_id
              OR invalid_pe.status<>'APPROVED')) AS has_invalid_allocations,
        COALESCE((SELECT sc.has_source_conflicts FROM source_conflicts sc WHERE sc.id=wp.id),false) AS has_source_conflicts
      FROM worker_payments wp
    )
      SELECT p.id AS production_entry_id,p.code AS production_code,p.employee_id,
             e.code AS employee_code,e.full_name AS employee_name,p.work_date,
             o.code AS order_code,o.order_name,s.name AS stage_name,
             COALESCE(p.total_earning_amount,p.earning_amount,0) AS earned_amount,
             COALESCE(a.amount,0) AS actual_paid_amount,
             CASE WHEN cce.id IS NOT NULL THEN cce.closed_amount_snapshot
                  WHEN m.status='PAID_PREVIOUSLY' THEN m.amount_snapshot ELSE 0 END AS historical_paid_amount,
             CASE WHEN cce.id IS NOT NULL THEN 0
               ELSE GREATEST(0,COALESCE(p.total_earning_amount,p.earning_amount,0)
                 -COALESCE(a.amount,0)
                 -CASE WHEN m.status='PAID_PREVIOUSLY' THEN m.amount_snapshot ELSE 0 END) END AS remaining_amount,
             GREATEST(0,COALESCE(a.amount,0)
               +CASE WHEN m.status='PAID_PREVIOUSLY' THEN m.amount_snapshot ELSE 0 END
               -COALESCE(p.total_earning_amount,p.earning_amount,0)) AS overpaid_amount,
             m.id AS mark_id,m.status AS mark_status,m.notes AS mark_notes,m.payment_date,
             EXISTS (
               SELECT 1 FROM payment_coverage pc
                WHERE pc.employee_id=p.employee_id AND pc.created_at::date>=p.work_date
                  AND (pc.expected_production_amount>pc.allocated_production_amount+0.009 OR pc.has_invalid_allocations OR pc.has_source_conflicts
                  OR EXISTS(SELECT 1 FROM unlinked_allocation_conflicts uac WHERE uac.employee_id=pc.employee_id AND uac.production_entry_id=p.id))
             ) AS ambiguous_payment_evidence,
             CASE
               WHEN cce.id IS NOT NULL THEN 'PAID_HISTORICALLY'
               WHEN COALESCE(a.amount,0)+CASE WHEN m.status='PAID_PREVIOUSLY' THEN m.amount_snapshot ELSE 0 END
                    >COALESCE(p.total_earning_amount,p.earning_amount,0)+0.009 THEN 'NEEDS_REVIEW'
               WHEN EXISTS (
                 SELECT 1 FROM payment_coverage pc
                  WHERE pc.employee_id=p.employee_id AND pc.created_at::date>=p.work_date
                    AND (pc.expected_production_amount>pc.allocated_production_amount+0.009 OR pc.has_invalid_allocations OR pc.has_source_conflicts
                  OR EXISTS(SELECT 1 FROM unlinked_allocation_conflicts uac WHERE uac.employee_id=pc.employee_id AND uac.production_entry_id=p.id))
               ) THEN 'NEEDS_REVIEW'
               WHEN COALESCE(a.amount,0)>=COALESCE(p.total_earning_amount,p.earning_amount,0)-0.009 THEN 'PAID_CONFIRMED'
               WHEN COALESCE(a.amount,0)>0.009 THEN 'NEEDS_REVIEW'
               WHEN m.status='PAID_PREVIOUSLY' THEN 'PAID_HISTORICALLY'
               WHEN EXISTS (
                 SELECT 1 FROM payment_coverage pc
                  WHERE pc.employee_id=p.employee_id AND pc.created_at::date>=p.work_date
                    AND (pc.expected_production_amount>pc.allocated_production_amount+0.009 OR pc.has_invalid_allocations OR pc.has_source_conflicts
                  OR EXISTS(SELECT 1 FROM unlinked_allocation_conflicts uac WHERE uac.employee_id=pc.employee_id AND uac.production_entry_id=p.id))
               ) THEN 'NEEDS_REVIEW'
               ELSE 'UNPAID'
             END AS classification
        FROM production_entries p
        JOIN employees e ON e.id=p.employee_id
        LEFT JOIN actual a ON a.production_entry_id=p.id
        LEFT JOIN historical_production_settlement_marks m ON m.production_entry_id=p.id
        LEFT JOIN employee_production_closure_entries cce
          ON cce.production_entry_id=p.id
         AND cce.closure_id=(SELECT active_closure.id FROM employee_production_closures active_closure
           WHERE active_closure.employee_id=p.employee_id AND active_closure.status='ACTIVE' LIMIT 1)
        LEFT JOIN order_stages os ON os.id=p.order_stage_id
        LEFT JOIN production_orders o ON o.id=os.order_id
        LEFT JOIN stages s ON s.id=os.stage_id
       WHERE p.status='APPROVED' AND ($1::uuid IS NULL OR p.employee_id=$1)
       ORDER BY p.work_date DESC,p.created_at DESC,p.id
    `,[parsed.data.employeeId??null]);
    return {data:result.rows};
  });

  app.get("/api/worker-payments/employee-production-closures", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    await assertClosurePassword(request);
    const result=await pool.query(`
      SELECT c.id,c.employee_id,e.code AS employee_code,e.full_name AS employee_name,
             c.closed_at,c.notes,c.approved_production_count,c.production_amount_snapshot,c.status,
             c.reversed_at,c.reversal_reason
        FROM employee_production_closures c
        JOIN employees e ON e.id=c.employee_id
       ORDER BY c.closed_at DESC
    `);
    return {data:result.rows};
  });

  app.post("/api/worker-payments/employee-production-closures", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    await assertClosurePassword(request);
    const parsed=z.object({employeeId:z.string().uuid(),notes:z.string().trim().min(3).max(500)}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","حدد العامل واكتب سبب الإقفال بوضوح",422);
    return {data:await withTransaction(async(client)=>{
      const locked=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[parsed.data.employeeId]);
      if(!locked.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND","العامل غير موجود أو غير نشط",404);
      const active=await client.query("SELECT id FROM employee_production_closures WHERE employee_id=$1 AND status='ACTIVE' FOR UPDATE",[parsed.data.employeeId]);
      if(active.rowCount) throw new AppError("EMPLOYEE_PRODUCTION_ALREADY_CLOSED","يوجد إقفال نشط لهذا العامل بالفعل",409);
      const approved=await client.query(
        "SELECT id FROM production_entries WHERE employee_id=$1 AND status='APPROVED' ORDER BY work_date,created_at,id FOR UPDATE",
        [parsed.data.employeeId]
      );
      if(!approved.rowCount) throw new AppError("NO_APPROVED_PRODUCTION","لا توجد سجلات إنتاج معتمدة لإقفالها",409);
      const snapshot=[];
      for(const entry of approved.rows){
        const settlement=await loadProductionSettlement(client,entry.id);
        if(!settlement) continue;
        if(settlement.ambiguous_payment_evidence){
          throw new AppError("AMBIGUOUS_PAYMENT_EVIDENCE","تعذر إقفال مستحقات العامل لأن هناك توزيعات سداد قديمة غير مؤكدة. راجع الحالات المالية أولًا.",409);
        }
        if(settlement.status!=="APPROVED"){
          throw new AppError("PRODUCTION_STATUS_CHANGED","تغيرت حالة أحد سجلات الإنتاج أثناء الإقفال. أعد المحاولة بعد المراجعة.",409);
        }
        const earned=Number(settlement.earned??0);
        const paid=Number(settlement.actual_paid??0)+(settlement.mark_status==="PAID_PREVIOUSLY"?Number(settlement.historical_paid??0):0);
        const remaining=Math.max(0,earned-paid);
        snapshot.push({id:settlement.id,earned,paid,remaining});
      }
      if(!snapshot.length) throw new AppError("NO_APPROVED_PRODUCTION","لا توجد سجلات إنتاج معتمدة لإقفالها",409);
      const total=snapshot.reduce((sum,row)=>sum+row.remaining,0);
      const created=await client.query(`
        INSERT INTO employee_production_closures
          (employee_id,notes,approved_production_count,production_amount_snapshot,closed_by)
        VALUES($1,$2,$3,$4,$5) RETURNING *
      `,[parsed.data.employeeId,parsed.data.notes,snapshot.length,total,request.user!.userId]);
      const closure=created.rows[0];
      for(const row of snapshot){
        await client.query(`
          INSERT INTO employee_production_closure_entries
            (closure_id,production_entry_id,earned_amount_snapshot,previously_paid_snapshot,closed_amount_snapshot)
          VALUES($1,$2,$3,$4,$5)
        `,[closure.id,row.id,row.earned,row.paid,row.remaining]);
      }
      await writeAudit(client,{
        actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,
        action:"employee_production_forced_closure",module:"payments",
        entityType:"employee_production_closure",entityId:closure.id,
        afterData:closure,
        metadata:{employeeId:parsed.data.employeeId,productionCount:snapshot.length,
          productionAmountSnapshot:total,productionEntryIds:snapshot.map(row=>row.id),
          financialMovementCreated:false,ledgerChanged:false,productionChanged:false,pricesChanged:false},
        ipAddress:request.ip,userAgent:request.headers["user-agent"]??null
      });
      return closure;
    })};
  });

  app.patch("/api/worker-payments/employee-production-closures/:closureId/reverse", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    await assertClosurePassword(request);
    const params=z.object({closureId:z.string().uuid()}).safeParse(request.params);
    const body=z.object({reason:z.string().trim().min(3).max(500)}).safeParse(request.body);
    if(!params.success||!body.success) throw new AppError("VALIDATION_ERROR","بيانات إلغاء الإقفال غير صحيحة",422);
    return {data:await withTransaction(async(client)=>{
      // Keep the global lock order employee -> closure, matching closure creation
      // and production approval. Locking the closure first can deadlock with a
      // concurrent new closure for the same employee.
      const identity=await client.query("SELECT employee_id FROM employee_production_closures WHERE id=$1",[params.data.closureId]);
      if(!identity.rowCount) throw new AppError("ACTIVE_CLOSURE_NOT_FOUND","الإقفال غير موجود أو تم إلغاؤه بالفعل",409);
      await client.query("SELECT id FROM employees WHERE id=$1 FOR UPDATE",[identity.rows[0].employee_id]);
      const current=await client.query("SELECT * FROM employee_production_closures WHERE id=$1 FOR UPDATE",[params.data.closureId]);
      if(!current.rowCount||current.rows[0].status!=="ACTIVE") throw new AppError("ACTIVE_CLOSURE_NOT_FOUND","الإقفال غير موجود أو تم إلغاؤه بالفعل",409);
      const updated=await client.query(`
        UPDATE employee_production_closures
           SET status='REVERSED',reversed_at=now(),reversed_by=$2,reversal_reason=$3,updated_at=now()
         WHERE id=$1 RETURNING *
      `,[params.data.closureId,request.user!.userId,body.data.reason]);
      await writeAudit(client,{
        actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,
        action:"employee_production_closure_reversed",module:"payments",
        entityType:"employee_production_closure",entityId:params.data.closureId,
        beforeData:current.rows[0],afterData:updated.rows[0],
        metadata:{productionChanged:false,financialMovementCreated:false},
        ipAddress:request.ip,userAgent:request.headers["user-agent"]??null
      });
      return updated.rows[0];
    })};
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
        if(Number(evidence.actual_paid)>=Number(evidence.earned)-0.009)
          throw new AppError("PRODUCTION_ALREADY_PAID","تم سداد قيمة سجل الإنتاج بالكامل بالفعل؛ لن يتم إنشاء تسوية تاريخية مكررة",409);
        if(evidence.hard_payment_conflict){
          throw new AppError("HISTORICAL_PAYMENT_ALLOCATION_CONFLICT","توجد مشكلة فعلية في توزيع دفعة سابقة (عامل/إنتاج غير مطابق أو مصادر توزيع متعارضة). يجب تصحيح التوزيع من شاشة مراجعة الدفعات القديمة قبل تثبيت السداد التاريخي.",409);
        }
        if(evidence.ambiguous_payment_evidence){
          const isManager=request.user?.roleCodes?.some(role=>["admin","manager","owner"].includes(role.toLowerCase()));
          if(!parsed.data.confirmAmbiguousPayment || !isManager)
            throw new AppError("HISTORICAL_PAYMENT_NEEDS_REVIEW","توجد دفعة قديمة غير موزعة بالكامل. لا يمكن اعتماد المتبقي كمدفوع إلا بتأكيد مدير النظام بعد مراجعة مستندات السداد.",409);
        }
      }
      const earned=Number(production.rows[0].earned);
      const amountSnapshot=parsed.data.status==="PAID_PREVIOUSLY"
        ? Math.max(0,Math.round((earned-Number(evidence.actual_paid))*10000)/10000)
        : Number(before.rows[0]?.amount_snapshot ?? earned);
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
        metadata:{employeeId,productionEntryId,amountSnapshot,ambiguousPaymentOverride:Boolean(parsed.data.confirmAmbiguousPayment&&evidence.ambiguous_payment_evidence),financialMovementCreated:false,affectsEmployeeLedger:false,affectsAdvances:false},
        ipAddress:request.ip,userAgent:request.headers["user-agent"]??null
      });
      return saved.rows[0];
    })};
  });
}