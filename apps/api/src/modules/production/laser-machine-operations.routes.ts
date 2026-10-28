import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const targetSchema = z.object({
  machineId: z.string().uuid(),
  designVersionId: z.string().uuid().nullable().optional(),
  shiftId: z.string().uuid().nullable().optional(),
  periodType: z.enum(["DAY","MONTH","SHIFT"]),
  date: z.string().date(),
  targetQuantity: z.number().positive(),
  targetCycles: z.number().int().positive().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
}).refine(x => x.periodType === "SHIFT" ? Boolean(x.shiftId) : !x.shiftId, {
  message: "اختر الوردية لهدف الوردية فقط، ويجب تحديد الوردية عند اختيار هذا النوع"
});

const startSessionSchema = z.object({
  machineId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  operatorEmployeeId: z.string().uuid().nullable().optional(),
  shiftId: z.string().uuid().nullable().optional(),
  targetId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});
const downtimeSchema = z.object({
  machineId: z.string().uuid(),
  reason: z.string().trim().min(2).max(500)
});
const stopSchema = z.object({ notes: z.string().trim().max(1000).optional() });

async function audit(client: any, request: any, action: string, entityType: string, entityId: string, afterData: unknown) {
  await writeAudit(client, {
    actorUserId: request.user!.userId,
    actorEmployeeId: request.user!.employeeId,
    action,
    module: "machine_production",
    entityType,
    entityId,
    afterData,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null
  });
}

function periodBounds(periodType: "DAY" | "MONTH" | "SHIFT", date: string) {
  if (periodType !== "MONTH") return { from: date, to: date };
  const year = Number(date.slice(0,4));
  const month = Number(date.slice(5,7));
  const from = date;
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0,10);
  return { from, to };
}

export async function laserMachineOperationsRoutes(app: FastifyInstance) {
  app.get("/api/laser-machine-targets", {
    preHandler: [authenticateRequest, requirePermission("machine_production.live.view")]
  }, async () => {
    const result = await pool.query(`
      SELECT t.id,t.machine_id,t.design_version_id,t.shift_id,t.period_type,t.effective_from,t.effective_to,
             t.target_quantity,t.target_cycles,t.notes,t.is_active,t.created_at,
             m.code AS machine_code,m.name AS machine_name,
             d.code AS design_code,d.name AS design_name,v.version_no,
             s.code AS shift_code,s.name AS shift_name
      FROM laser_machine_targets t
      JOIN machines m ON m.id=t.machine_id
      LEFT JOIN laser_design_versions v ON v.id=t.design_version_id
      LEFT JOIN laser_designs d ON d.id=v.design_id
      LEFT JOIN shifts s ON s.id=t.shift_id
      ORDER BY t.is_active DESC,t.effective_from DESC,m.name
    `);
    return { data: result.rows };
  });

  app.post("/api/laser-machine-targets", {
    preHandler: [authenticateRequest, requirePermission("machine_production.targets.manage")]
  }, async (request, reply) => {
    const parsed = targetSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات مستهدف الإنتاج غير صحيحة", 422);
    const bounds = periodBounds(parsed.data.periodType, parsed.data.date);
    const result = await withTransaction(async client => {
      const machine = await client.query("SELECT id FROM machines WHERE id=$1 AND is_active=TRUE FOR UPDATE", [parsed.data.machineId]);
      if (!machine.rowCount) throw new AppError("MACHINE_NOT_ACTIVE", "الماكينة غير موجودة أو غير نشطة", 422);
      if (parsed.data.designVersionId) {
        const compatible = await client.query(`
          SELECT v.id FROM laser_machine_design_compatibility c
          JOIN laser_design_versions v ON v.id=c.design_version_id AND v.status='ACTIVE'
          JOIN laser_designs d ON d.id=v.design_id AND d.status='ACTIVE'
          WHERE c.machine_id=$1 AND c.design_version_id=$2 AND c.is_active=TRUE
            AND c.effective_from<=$3::date AND (c.effective_to IS NULL OR c.effective_to >= $3::date)
          LIMIT 1
        `, [parsed.data.machineId,parsed.data.designVersionId,bounds.from]);
        if (!compatible.rowCount) throw new AppError("LASER_DESIGN_NOT_COMPATIBLE", "التصميم غير متوافق مع الماكينة خلال بداية فترة المستهدف", 422);
      }
      if (parsed.data.shiftId) {
        const shift = await client.query("SELECT id FROM shifts WHERE id=$1 AND is_active=TRUE", [parsed.data.shiftId]);
        if (!shift.rowCount) throw new AppError("SHIFT_NOT_ACTIVE", "الوردية غير موجودة أو غير نشطة", 422);
      }
      const duplicate = await client.query(`
        SELECT id FROM laser_machine_targets
        WHERE machine_id=$1 AND design_version_id IS NOT DISTINCT FROM $2::uuid
          AND shift_id IS NOT DISTINCT FROM $3::uuid AND period_type=$4 AND effective_from=$5::date
          LIMIT 1
      `, [parsed.data.machineId,parsed.data.designVersionId ?? null,parsed.data.shiftId ?? null,parsed.data.periodType,bounds.from]);
      if (duplicate.rowCount) throw new AppError("TARGET_ALREADY_EXISTS", "يوجد مستهدف محفوظ بنفس الماكينة والتصميم والوردية وتاريخ البداية؛ اختر تاريخ بداية آخر", 409);
      if (parsed.data.periodType === "MONTH") {
        const future = await client.query(`
          SELECT id FROM laser_machine_targets
          WHERE machine_id=$1 AND design_version_id IS NOT DISTINCT FROM $2::uuid
            AND shift_id IS NOT DISTINCT FROM $3::uuid AND period_type='MONTH' AND is_active=TRUE
            AND effective_from>$4::date AND effective_from<=$5::date
          FOR UPDATE
        `, [parsed.data.machineId,parsed.data.designVersionId ?? null,parsed.data.shiftId ?? null,bounds.from,bounds.to]);
        if (future.rowCount) throw new AppError("TARGET_FUTURE_REVISION_EXISTS", "يوجد مستهدف أحدث داخل هذا الشهر؛ ابدأ التعديل من تاريخ بعده", 409);
        const previous = await client.query(`
          SELECT id FROM laser_machine_targets
          WHERE machine_id=$1 AND design_version_id IS NOT DISTINCT FROM $2::uuid
            AND shift_id IS NOT DISTINCT FROM $3::uuid AND period_type='MONTH' AND is_active=TRUE
            AND effective_from<$4::date AND effective_to>=$4::date
          FOR UPDATE
        `, [parsed.data.machineId,parsed.data.designVersionId ?? null,parsed.data.shiftId ?? null,bounds.from]);
        for (const prior of previous.rows) {
          await client.query("UPDATE laser_machine_targets SET effective_to=$2::date-1 WHERE id=$1", [prior.id,bounds.from]);
        }
      }
      const inserted = await client.query(`
        INSERT INTO laser_machine_targets(machine_id,design_version_id,shift_id,period_type,effective_from,effective_to,target_quantity,target_cycles,notes,created_by)
        VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10)
        RETURNING *
      `, [parsed.data.machineId,parsed.data.designVersionId ?? null,parsed.data.shiftId ?? null,parsed.data.periodType,bounds.from,bounds.to,
        parsed.data.targetQuantity,parsed.data.targetCycles ?? null,parsed.data.notes ?? null,request.user!.userId]);
      await audit(client,request,"create_target","laser_machine_target",inserted.rows[0].id,inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/laser-machine-targets/:id/deactivate", {
    preHandler: [authenticateRequest, requirePermission("machine_production.targets.manage")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const result = await withTransaction(async client => {
      const updated = await client.query("UPDATE laser_machine_targets SET is_active=FALSE,effective_to=CASE WHEN effective_from>CURRENT_DATE THEN effective_to ELSE LEAST(effective_to,CURRENT_DATE) END WHERE id=$1 AND is_active=TRUE RETURNING *", [id]);
      if (!updated.rowCount) throw new AppError("TARGET_NOT_FOUND", "المستهدف غير موجود أو متوقف بالفعل", 404);
      await audit(client,request,"deactivate_target","laser_machine_target",id,updated.rows[0]);
      return updated.rows[0];
    });
    return { data: result };
  });

  app.get("/api/laser-machine-sessions", {
    preHandler: [authenticateRequest, requirePermission("machine_production.live.view")]
  }, async () => {
    const result = await pool.query(`
      SELECT m.id AS machine_id,m.code AS machine_code,m.name AS machine_name,m.machine_type,
             s.id AS session_id,s.status AS session_status,s.started_at,s.ended_at,s.notes AS session_notes,
             d.code AS design_code,d.name AS design_name,v.version_no,v.material_type,v.material_thickness_mm,
             e.full_name AS operator_name,sh.name AS shift_name,
             t.target_quantity,t.target_cycles,
             COALESCE(prod.good_quantity,0) AS achieved_quantity,
             COALESCE(prod.scrap_quantity,0) AS scrap_quantity,
             COALESCE(prod.cycles_count,0) AS achieved_cycles,
             CASE WHEN t.target_quantity IS NULL THEN NULL ELSE GREATEST(0,t.target_quantity-COALESCE(prod.good_quantity,0)) END AS remaining_quantity,
             dt.id AS downtime_id,dt.reason AS downtime_reason,dt.started_at AS downtime_started_at,
             last_s.started_at AS last_session_started_at,last_s.status AS last_session_status
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT ms.* FROM laser_machine_sessions ms
        WHERE ms.machine_id=m.id AND ms.status='RUNNING'
        ORDER BY ms.started_at DESC LIMIT 1
      ) s ON TRUE
      LEFT JOIN LATERAL (
        SELECT ms.started_at,ms.status FROM laser_machine_sessions ms
        WHERE ms.machine_id=m.id ORDER BY ms.started_at DESC LIMIT 1
      ) last_s ON TRUE
      LEFT JOIN laser_design_versions v ON v.id=s.design_version_id
      LEFT JOIN laser_designs d ON d.id=v.design_id
      LEFT JOIN employees e ON e.id=s.operator_employee_id
      LEFT JOIN shifts sh ON sh.id=s.shift_id
      LEFT JOIN laser_machine_targets t ON t.id=s.target_id
      LEFT JOIN LATERAL (
        SELECT SUM(COALESCE(mp.good_quantity,mp.quantity)) AS good_quantity,
               SUM(COALESCE(mp.scrap_quantity,0)) AS scrap_quantity,
               SUM(COALESCE(mp.cycles_count,0)) AS cycles_count
        FROM machine_productions mp
        WHERE mp.machine_id=m.id AND mp.status='ACTIVE'
          AND (
            (t.id IS NOT NULL
              AND mp.created_at>=t.effective_from::timestamptz
              AND mp.created_at<(t.effective_to + 1)::timestamptz
              AND (t.design_version_id IS NULL OR mp.laser_design_version_id=t.design_version_id)
              AND (t.shift_id IS NULL OR mp.shift_id=t.shift_id))
            OR
            (t.id IS NULL AND mp.laser_design_version_id=s.design_version_id AND mp.created_at>=s.started_at)
          )
      ) prod ON TRUE
      LEFT JOIN laser_machine_downtime_events dt ON dt.machine_id=m.id AND dt.ended_at IS NULL
      WHERE m.is_active=TRUE
      ORDER BY CASE WHEN s.id IS NOT NULL THEN 0 ELSE 1 END,m.name
    `);
    return { data: result.rows };
  });

  app.post("/api/laser-machine-sessions", {
    preHandler: [authenticateRequest, requirePermission("machine_production.sessions.manage")]
  }, async (request, reply) => {
    const parsed = startSessionSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات بدء تشغيل الماكينة غير صحيحة", 422);
    const result = await withTransaction(async client => {
      const machine = await client.query("SELECT id FROM machines WHERE id=$1 AND is_active=TRUE FOR UPDATE", [parsed.data.machineId]);
      if (!machine.rowCount) throw new AppError("MACHINE_NOT_ACTIVE", "الماكينة غير موجودة أو غير نشطة", 422);
      const current = await client.query("SELECT id FROM laser_machine_sessions WHERE machine_id=$1 AND status='RUNNING' FOR UPDATE", [parsed.data.machineId]);
      if (current.rowCount) throw new AppError("MACHINE_ALREADY_RUNNING", "الماكينة لديها جلسة تشغيل مفتوحة بالفعل؛ أنهِ الجلسة الحالية أولًا", 409);
      const downtime = await client.query("SELECT id FROM laser_machine_downtime_events WHERE machine_id=$1 AND ended_at IS NULL", [parsed.data.machineId]);
      if (downtime.rowCount) throw new AppError("MACHINE_DOWNTIME_OPEN", "أغلق سجل التوقف المفتوح قبل بدء جلسة تشغيل جديدة", 409);
      const compatible = await client.query(`
        SELECT c.id FROM laser_machine_design_compatibility c
        JOIN laser_design_versions v ON v.id=c.design_version_id AND v.status='ACTIVE'
        JOIN laser_designs d ON d.id=v.design_id AND d.status='ACTIVE'
        WHERE c.machine_id=$1 AND c.design_version_id=$2 AND c.is_active=TRUE
          AND c.effective_from<=CURRENT_DATE AND (c.effective_to IS NULL OR c.effective_to>=CURRENT_DATE)
        LIMIT 1
      `, [parsed.data.machineId,parsed.data.designVersionId]);
      if (!compatible.rowCount) throw new AppError("LASER_DESIGN_NOT_COMPATIBLE", "إصدار التصميم غير متوافق مع الماكينة أو غير نشط", 422);
      if (parsed.data.operatorEmployeeId) {
        const operator = await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE", [parsed.data.operatorEmployeeId]);
        if (!operator.rowCount) throw new AppError("EMPLOYEE_NOT_ACTIVE", "المشغل غير موجود أو غير نشط", 422);
      }
      if (parsed.data.shiftId) {
        const shift = await client.query("SELECT id FROM shifts WHERE id=$1 AND is_active=TRUE", [parsed.data.shiftId]);
        if (!shift.rowCount) throw new AppError("SHIFT_NOT_ACTIVE", "الوردية غير موجودة أو غير نشطة", 422);
      }
      if (parsed.data.targetId) {
        const target = await client.query(`
          SELECT id FROM laser_machine_targets
          WHERE id=$1 AND machine_id=$2 AND is_active=TRUE
            AND effective_from<=CURRENT_DATE AND effective_to>=CURRENT_DATE
            AND (design_version_id IS NULL OR design_version_id=$3)
            AND (shift_id IS NULL OR shift_id IS NOT DISTINCT FROM $4::uuid)
        `, [parsed.data.targetId,parsed.data.machineId,parsed.data.designVersionId,parsed.data.shiftId ?? null]);
        if (!target.rowCount) throw new AppError("TARGET_NOT_VALID", "المستهدف لا ينطبق على الماكينة أو التصميم أو الوردية أو التاريخ الحالي", 422);
      }
      const inserted = await client.query(`
        INSERT INTO laser_machine_sessions(machine_id,design_version_id,operator_employee_id,shift_id,target_id,started_by,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [parsed.data.machineId,parsed.data.designVersionId,parsed.data.operatorEmployeeId ?? null,parsed.data.shiftId ?? null,
        parsed.data.targetId ?? null,request.user!.userId,parsed.data.notes ?? null]);
      await audit(client,request,"start_session","laser_machine_session",inserted.rows[0].id,inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.post("/api/laser-machine-sessions/:id/stop", {
    preHandler: [authenticateRequest, requirePermission("machine_production.sessions.manage")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const parsed = stopSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "ملاحظات إنهاء التشغيل غير صحيحة", 422);
    const result = await withTransaction(async client => {
      const session = await client.query("SELECT * FROM laser_machine_sessions WHERE id=$1 FOR UPDATE", [id]);
      if (!session.rowCount || session.rows[0].status !== "RUNNING") throw new AppError("SESSION_NOT_RUNNING", "جلسة التشغيل غير موجودة أو منتهية بالفعل", 409);
      await client.query(`
        UPDATE laser_machine_downtime_events SET ended_at=now(),ended_by=$2
        WHERE machine_id=$1 AND ended_at IS NULL
      `, [session.rows[0].machine_id,request.user!.userId]);
      const updated = await client.query(`
        UPDATE laser_machine_sessions SET status='STOPPED',ended_at=now(),ended_by=$2,
          notes=CASE WHEN $3::text IS NULL OR trim($3::text)='' THEN notes
                     WHEN notes IS NULL OR trim(notes)='' THEN $3::text ELSE notes || E'\n' || $3::text END
        WHERE id=$1 RETURNING *
      `, [id,request.user!.userId,parsed.data.notes ?? null]);
      await audit(client,request,"stop_session","laser_machine_session",id,updated.rows[0]);
      return updated.rows[0];
    });
    return { data: result };
  });

  app.post("/api/laser-machine-downtime", {
    preHandler: [authenticateRequest, requirePermission("machine_production.downtime.manage")]
  }, async (request, reply) => {
    const parsed = downtimeSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "أدخل سبب توقف واضحًا", 422);
    const result = await withTransaction(async client => {
      const machine = await client.query("SELECT id FROM machines WHERE id=$1 AND is_active=TRUE FOR UPDATE", [parsed.data.machineId]);
      if (!machine.rowCount) throw new AppError("MACHINE_NOT_ACTIVE", "الماكينة غير موجودة أو غير نشطة", 422);
      const session = await client.query("SELECT id FROM laser_machine_sessions WHERE machine_id=$1 AND status='RUNNING' FOR UPDATE", [parsed.data.machineId]);
      if (!session.rowCount) throw new AppError("NO_ACTIVE_SESSION", "لا توجد جلسة تشغيل مفتوحة لتسجيل التوقف عليها", 409);
      const existing = await client.query("SELECT id FROM laser_machine_downtime_events WHERE machine_id=$1 AND ended_at IS NULL", [parsed.data.machineId]);
      if (existing.rowCount) throw new AppError("DOWNTIME_ALREADY_OPEN", "يوجد توقف مفتوح بالفعل لهذه الماكينة", 409);
      const inserted = await client.query(`
        INSERT INTO laser_machine_downtime_events(machine_id,session_id,reason,created_by)
        VALUES($1,$2,$3,$4) RETURNING *
      `, [parsed.data.machineId,session.rows[0].id,parsed.data.reason,request.user!.userId]);
      await audit(client,request,"start_downtime","laser_machine_downtime",inserted.rows[0].id,inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/laser-machine-downtime/:id/end", {
    preHandler: [authenticateRequest, requirePermission("machine_production.downtime.manage")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const result = await withTransaction(async client => {
      const updated = await client.query(`
        UPDATE laser_machine_downtime_events SET ended_at=now(),ended_by=$2
        WHERE id=$1 AND ended_at IS NULL RETURNING *
      `, [id,request.user!.userId]);
      if (!updated.rowCount) throw new AppError("DOWNTIME_NOT_OPEN", "سجل التوقف غير موجود أو منتهٍ بالفعل", 404);
      await audit(client,request,"end_downtime","laser_machine_downtime",id,updated.rows[0]);
      return updated.rows[0];
    });
    return { data: result };
  });
}
