import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const designSchema = z.object({
  name: z.string().trim().min(2).max(160),
  thumbnailUrl: z.string().url().max(2048).nullable().optional(),
  fileReference: z.string().trim().max(1000).nullable().optional()
});
const versionSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  versionNo: z.number().int().positive(),
  materialType: z.string().trim().min(1).max(80),
  materialThicknessMm: z.number().nonnegative().nullable().optional(),
  widthMm: z.number().positive().nullable().optional(),
  heightMm: z.number().positive().nullable().optional(),
  unitLabel: z.string().trim().min(1).max(40).default("قطعة"),
  piecesPerCycle: z.number().int().positive(),
  standardCycleSeconds: z.number().positive().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
});
const compatibilitySchema = z.object({
  machineId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  settingsNotes: z.string().trim().max(2000).nullable().optional(),
  piecesPerCycleOverride: z.number().int().positive().nullable().optional(),
  standardCycleSecondsOverride: z.number().positive().nullable().optional(),
  effectiveFrom: z.string().date().optional()
});

async function audit(client: any, request: any, action: string, entityType: string, entityId: string, afterData: unknown) {
  await writeAudit(client, {
    actorUserId: request.user!.userId,
    actorEmployeeId: request.user!.employeeId,
    action,
    module: "laser_designs",
    entityType,
    entityId,
    afterData,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null
  });
}

export async function laserDesignRoutes(app: FastifyInstance) {
  app.get("/api/laser-designs", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.view")]
  }, async () => {
    const result = await pool.query(`
      SELECT d.id,d.code,d.name,d.thumbnail_url,d.file_reference,d.status,d.created_at,d.updated_at,
             COUNT(v.id)::int AS version_count,
             MAX(v.version_no) AS latest_version_no
      FROM laser_designs d
      LEFT JOIN laser_design_versions v ON v.design_id=d.id
      GROUP BY d.id
      ORDER BY d.status ASC,d.name ASC,d.code ASC
    `);
    return { data: result.rows };
  });

  app.post("/api/laser-designs", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.manage")]
  }, async (request, reply) => {
    const parsed = designSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "تحقق من اسم التصميم ورابط المعاينة أو مرجع الملف", 422);
    const result = await withTransaction(async client => {
      const inserted = await client.query(`
        INSERT INTO laser_designs(name,thumbnail_url,file_reference,created_by,updated_by)
        VALUES($1,$2,$3,$4,$4)
        RETURNING id,code,name,thumbnail_url,file_reference,status,created_at,updated_at
      `, [parsed.data.name, parsed.data.thumbnailUrl ?? null, parsed.data.fileReference ?? null, request.user!.userId]);
      await audit(client, request, "create", "laser_design", inserted.rows[0].id, inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/laser-designs/:id/archive", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.manage")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const result = await withTransaction(async client => {
      const updated = await client.query(`
        UPDATE laser_designs SET status='ARCHIVED',updated_by=$2,updated_at=now()
        WHERE id=$1 AND status='ACTIVE'
        RETURNING id,code,name,status,updated_at
      `, [id, request.user!.userId]);
      if (!updated.rowCount) throw new AppError("LASER_DESIGN_NOT_FOUND", "التصميم غير موجود أو مؤرشف بالفعل", 404);
      await audit(client, request, "archive", "laser_design", id, updated.rows[0]);
      return updated.rows[0];
    });
    return { data: result };
  });

  app.get("/api/laser-designs/:id/versions", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.view")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const result = await pool.query(`
      SELECT v.id,v.design_id,v.product_id,v.version_no,v.material_type,v.material_thickness_mm,
             v.width_mm,v.height_mm,v.unit_label,v.pieces_per_cycle,v.standard_cycle_seconds,
             v.notes,v.status,v.created_at,d.code AS design_code,d.name AS design_name
      FROM laser_design_versions v JOIN laser_designs d ON d.id=v.design_id
      WHERE v.design_id=$1 ORDER BY v.version_no DESC
    `, [id]);
    return { data: result.rows };
  });

  app.get("/api/laser-design-versions", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.view")]
  }, async () => {
    const result = await pool.query(`
      SELECT v.id,v.design_id,v.product_id,v.version_no,v.material_type,v.material_thickness_mm,
             v.width_mm,v.height_mm,v.unit_label,v.pieces_per_cycle,v.standard_cycle_seconds,
             v.notes,v.status,d.code AS design_code,d.name AS design_name,d.status AS design_status
      FROM laser_design_versions v JOIN laser_designs d ON d.id=v.design_id
      ORDER BY d.name ASC,v.version_no DESC
    `);
    return { data: result.rows };
  });

  app.post("/api/laser-designs/:id/versions", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.manage")]
  }, async (request, reply) => {
    const designId = (request.params as { id: string }).id;
    const parsed = versionSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات إصدار التصميم غير صحيحة؛ راجع الخامة والمقاس وعدد القطع في الدورة", 422);
    const result = await withTransaction(async client => {
      const design = await client.query("SELECT id,status FROM laser_designs WHERE id=$1 FOR UPDATE", [designId]);
      if (!design.rowCount || design.rows[0].status !== "ACTIVE") {
        throw new AppError("LASER_DESIGN_NOT_ACTIVE", "لا يمكن إضافة إصدار لتصميم غير موجود أو مؤرشف", 409);
      }
      if (parsed.data.productId) {
        const product = await client.query("SELECT id FROM products WHERE id=$1 AND is_active=TRUE", [parsed.data.productId]);
        if (!product.rowCount) throw new AppError("PRODUCT_NOT_ACTIVE", "المنتج المرتبط بإصدار التصميم غير موجود أو غير نشط", 422);
      }
      const duplicate = await client.query("SELECT id FROM laser_design_versions WHERE design_id=$1 AND version_no=$2", [designId,parsed.data.versionNo]);
      if (duplicate.rowCount) throw new AppError("LASER_VERSION_EXISTS", "رقم الإصدار مستخدم بالفعل لهذا التصميم؛ اختر رقم إصدار جديدًا", 409);
      const inserted = await client.query(`
        INSERT INTO laser_design_versions(
          design_id,product_id,version_no,material_type,material_thickness_mm,width_mm,height_mm,
          unit_label,pieces_per_cycle,standard_cycle_seconds,notes,created_by
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `, [designId,parsed.data.productId ?? null,parsed.data.versionNo,parsed.data.materialType,parsed.data.materialThicknessMm ?? null,
        parsed.data.widthMm ?? null,parsed.data.heightMm ?? null,parsed.data.unitLabel,parsed.data.piecesPerCycle,
        parsed.data.standardCycleSeconds ?? null,parsed.data.notes ?? null,request.user!.userId]);
      await audit(client, request, "create_version", "laser_design_version", inserted.rows[0].id, inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.get("/api/laser-machine-design-compatibility", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.view")]
  }, async () => {
    const result = await pool.query(`
      SELECT c.id,c.machine_id,c.design_version_id,c.settings_notes,c.pieces_per_cycle_override,
             c.standard_cycle_seconds_override,c.effective_from,c.effective_to,c.is_active,c.created_at,
             m.code AS machine_code,m.name AS machine_name,
             d.id AS design_id,d.code AS design_code,d.name AS design_name,d.status AS design_status,
             v.version_no,v.material_type,v.material_thickness_mm,v.unit_label,v.pieces_per_cycle,
             v.standard_cycle_seconds,v.status AS version_status
      FROM laser_machine_design_compatibility c
      JOIN machines m ON m.id=c.machine_id
      JOIN laser_design_versions v ON v.id=c.design_version_id
      JOIN laser_designs d ON d.id=v.design_id
      ORDER BY c.is_active DESC,m.name,d.name,v.version_no DESC,c.effective_from DESC
    `);
    return { data: result.rows };
  });

  app.get("/api/machines/:id/laser-designs", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.view")]
  }, async request => {
    const machineId = (request.params as { id: string }).id;
    const result = await pool.query(`
      SELECT c.id AS compatibility_id,c.settings_notes,
             COALESCE(c.pieces_per_cycle_override,v.pieces_per_cycle) AS pieces_per_cycle,
             COALESCE(c.standard_cycle_seconds_override,v.standard_cycle_seconds) AS standard_cycle_seconds,
             d.id AS design_id,d.code AS design_code,d.name AS design_name,d.thumbnail_url,
             v.product_id,v.id AS design_version_id,v.version_no,v.material_type,v.material_thickness_mm,
             v.width_mm,v.height_mm,v.unit_label
      FROM laser_machine_design_compatibility c
      JOIN machines m ON m.id=c.machine_id AND m.is_active=TRUE
      JOIN laser_design_versions v ON v.id=c.design_version_id AND v.status='ACTIVE'
      JOIN laser_designs d ON d.id=v.design_id AND d.status='ACTIVE'
      WHERE c.machine_id=$1 AND c.is_active=TRUE
        AND c.effective_from<=CURRENT_DATE AND (c.effective_to IS NULL OR c.effective_to>=CURRENT_DATE)
      ORDER BY d.name,v.version_no DESC
    `, [machineId]);
    return { data: result.rows };
  });

  app.post("/api/laser-machine-design-compatibility", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.compatibility.manage")]
  }, async (request, reply) => {
    const parsed = compatibilitySchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات توافق الماكينة والتصميم غير صحيحة", 422);
    const result = await withTransaction(async client => {
      const machine = await client.query("SELECT id FROM machines WHERE id=$1 AND is_active=TRUE FOR UPDATE", [parsed.data.machineId]);
      if (!machine.rowCount) throw new AppError("MACHINE_NOT_ACTIVE", "الماكينة غير موجودة أو غير نشطة", 422);
      const version = await client.query(`
        SELECT v.id,v.product_id,v.status AS version_status,d.status AS design_status
        FROM laser_design_versions v JOIN laser_designs d ON d.id=v.design_id
        WHERE v.id=$1 FOR UPDATE OF v,d
      `, [parsed.data.designVersionId]);
      if (!version.rowCount || version.rows[0].version_status !== "ACTIVE" || version.rows[0].design_status !== "ACTIVE") {
        throw new AppError("LASER_DESIGN_VERSION_NOT_ACTIVE", "اختر إصدارًا نشطًا من تصميم نشط", 422);
      }
      const existing = await client.query(`
        SELECT id FROM laser_machine_design_compatibility
        WHERE machine_id=$1 AND design_version_id=$2 AND is_active=TRUE
          AND (effective_to IS NULL OR effective_to >= COALESCE($3::date,CURRENT_DATE))
        LIMIT 1
      `, [parsed.data.machineId,parsed.data.designVersionId,parsed.data.effectiveFrom ?? null]);
      if (existing.rowCount) throw new AppError("COMPATIBILITY_ALREADY_EXISTS", "هذا التصميم مرتبط بالفعل بالماكينة؛ راجع سجل التوافق بدل إنشاء ربط مكرر", 409);
      const inserted = await client.query(`
        INSERT INTO laser_machine_design_compatibility(
          machine_id,design_version_id,settings_notes,pieces_per_cycle_override,
          standard_cycle_seconds_override,effective_from,created_by
        ) VALUES($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7)
        RETURNING *
      `, [parsed.data.machineId,parsed.data.designVersionId,parsed.data.settingsNotes ?? null,
        parsed.data.piecesPerCycleOverride ?? null,parsed.data.standardCycleSecondsOverride ?? null,
        parsed.data.effectiveFrom ?? null,request.user!.userId]);
      await audit(client, request, "create_compatibility", "laser_machine_design_compatibility", inserted.rows[0].id, inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/laser-machine-design-compatibility/:id/deactivate", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.compatibility.manage")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const result = await withTransaction(async client => {
      const updated = await client.query(`
        UPDATE laser_machine_design_compatibility
        SET is_active=FALSE,effective_to=GREATEST(effective_from,CURRENT_DATE)
        WHERE id=$1 AND is_active=TRUE
        RETURNING *
      `, [id]);
      if (!updated.rowCount) throw new AppError("COMPATIBILITY_NOT_FOUND", "سجل التوافق غير موجود أو معطل بالفعل", 404);
      await audit(client, request, "deactivate_compatibility", "laser_machine_design_compatibility", id, updated.rows[0]);
      return updated.rows[0];
    });
    return { data: result };
  });

const orderStageDesignSchema = z.object({
  orderStageId: z.string().uuid(),
  machineId: z.string().uuid(),
  designVersionId: z.string().uuid(),
  plannedQuantity: z.number().positive().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
});


  app.get("/api/laser-order-stage-designs", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.order_plan.view")]
  }, async request => {
    const query = request.query as { orderId?: string; orderStageId?: string; machineId?: string };
    const result = await pool.query(`
      SELECT x.id,x.order_stage_id,x.machine_id,x.design_version_id,x.planned_quantity,x.notes,
             x.is_active,x.created_at,
             os.order_id,o.code AS order_code,o.order_name,os.stage_id,s.name AS stage_name,os.sequence_no,
             m.code AS machine_code,m.name AS machine_name,
             d.code AS design_code,d.name AS design_name,v.version_no,v.material_type,
             v.material_thickness_mm,v.unit_label,v.pieces_per_cycle
      FROM laser_order_stage_designs x
      JOIN order_stages os ON os.id=x.order_stage_id
      JOIN production_orders o ON o.id=os.order_id
      JOIN stages s ON s.id=os.stage_id
      JOIN machines m ON m.id=x.machine_id
      JOIN laser_design_versions v ON v.id=x.design_version_id
      JOIN laser_designs d ON d.id=v.design_id
      WHERE ($1::uuid IS NULL OR os.order_id=$1)
        AND ($2::uuid IS NULL OR os.id=$2)
        AND ($3::uuid IS NULL OR x.machine_id=$3)
      ORDER BY x.is_active DESC,o.created_at DESC,os.sequence_no,m.name,d.name,v.version_no DESC
    `, [query.orderId ?? null,query.orderStageId ?? null,query.machineId ?? null]);
    return { data: result.rows };
  });

  app.post("/api/laser-order-stage-designs", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.order_plan.manage")]
  }, async (request, reply) => {
    const parsed = orderStageDesignSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اختر الطلبية والمرحلة والماكينة وإصدار التصميم، وتأكد من الكمية", 422);
    const result = await withTransaction(async client => {
      const stage = await client.query(`
        SELECT os.id,os.order_id,o.order_name,os.status AS stage_status,o.status AS order_status
        FROM order_stages os JOIN production_orders o ON o.id=os.order_id
        WHERE os.id=$1 FOR UPDATE OF os
      `, [parsed.data.orderStageId]);
      if (!stage.rowCount || stage.rows[0].stage_status === "CANCELLED" || ["CANCELLED","COMPLETED"].includes(stage.rows[0].order_status)) {
        throw new AppError("ORDER_STAGE_NOT_ACTIVE", "المرحلة أو الطلبية غير متاحة للتخطيط", 422);
      }
      const machine = await client.query("SELECT id FROM machines WHERE id=$1 AND is_active=TRUE FOR UPDATE", [parsed.data.machineId]);
      if (!machine.rowCount) throw new AppError("MACHINE_NOT_ACTIVE", "الماكينة غير موجودة أو غير نشطة", 422);
      const version = await client.query(`
        SELECT v.id,v.status AS version_status,d.status AS design_status
        FROM laser_design_versions v JOIN laser_designs d ON d.id=v.design_id
        WHERE v.id=$1 FOR UPDATE OF v,d
      `, [parsed.data.designVersionId]);
      if (!version.rowCount || version.rows[0].version_status !== "ACTIVE" || version.rows[0].design_status !== "ACTIVE") {
        throw new AppError("LASER_DESIGN_VERSION_NOT_ACTIVE", "اختر إصدارًا نشطًا من تصميم نشط", 422);
      }
      const compatible = await client.query(`
        SELECT id FROM laser_machine_design_compatibility
        WHERE machine_id=$1 AND design_version_id=$2 AND is_active=TRUE
          AND effective_from<=CURRENT_DATE AND (effective_to IS NULL OR effective_to>=CURRENT_DATE)
        LIMIT 1
      `, [parsed.data.machineId,parsed.data.designVersionId]);
      if (!compatible.rowCount) throw new AppError("LASER_DESIGN_NOT_COMPATIBLE", "التصميم غير مربوط بهذه الماكينة حاليًا. أضف توافق الماكينة من مكتبة تصميمات الليزر أولًا.", 422);
      const duplicate = await client.query(`
        SELECT id FROM laser_order_stage_designs
        WHERE order_stage_id=$1 AND machine_id=$2 AND design_version_id=$3 AND is_active=TRUE
      `, [parsed.data.orderStageId,parsed.data.machineId,parsed.data.designVersionId]);
      if (duplicate.rowCount) throw new AppError("ORDER_STAGE_DESIGN_EXISTS", "التصميم مربوط بالفعل بهذه المرحلة والماكينة", 409);
      const inserted = await client.query(`
        INSERT INTO laser_order_stage_designs(order_stage_id,machine_id,design_version_id,planned_quantity,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *
      `, [parsed.data.orderStageId,parsed.data.machineId,parsed.data.designVersionId,parsed.data.plannedQuantity ?? null,parsed.data.notes ?? null,request.user!.userId]);
      await audit(client,request,"assign_order_stage_design","laser_order_stage_design",inserted.rows[0].id,inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/laser-order-stage-designs/:id/deactivate", {
    preHandler: [authenticateRequest, requirePermission("laser_designs.order_plan.manage")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const result = await withTransaction(async client => {
      const updated = await client.query(`
        UPDATE laser_order_stage_designs
        SET is_active=FALSE,deactivated_by=$2,deactivated_at=now()
        WHERE id=$1 AND is_active=TRUE RETURNING *
      `, [id,request.user!.userId]);
      if (!updated.rowCount) throw new AppError("ORDER_STAGE_DESIGN_NOT_FOUND", "ربط التصميم غير موجود أو متوقف بالفعل", 404);
      await audit(client,request,"deactivate_order_stage_design","laser_order_stage_design",id,updated.rows[0]);
      return updated.rows[0];
    });
    return { data: result };
  });
}
