import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { verifyPassword } from "../auth/auth.service.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";

const machineSchema = z.object({
  name: z.string().trim().min(2).max(120),
  machineType: z.string().trim().max(120).nullable().optional()
});
const productionSchema = z.object({
  machineId: z.string().uuid(),
  productId: z.string().uuid(),
  productionTypeId: z.string().uuid().nullable().optional(),
  orderStageId: z.string().uuid(),
  employeeId: z.string().uuid().nullable().optional(),
  shiftId: z.string().uuid().nullable().optional(),
  workDate: z.string().date(),
  quantity: z.number().finite().positive().max(1000000000),
  notes: z.string().trim().max(1000).optional().default("")
});
const cancelSchema = z.object({
  password: z.string().min(1).max(200),
  reason: z.string().trim().min(3).max(500)
});

export async function machineProductionRoutes(app: FastifyInstance) {
  app.get("/api/machines", {
    preHandler: [authenticateRequest, requirePermission("machines.view")]
  }, async () => {
    const result = await pool.query(
      "SELECT id,code,name,machine_type,is_active FROM machines WHERE is_active=TRUE ORDER BY name,code"
    );
    return { data: result.rows };
  });

  app.post("/api/machines", {
    preHandler: [authenticateRequest, requirePermission("machines.create")]
  }, async (request, reply) => {
    const parsed = machineSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اسم الماكينة أو بياناتها غير صحيحة", 422);
    const row = await withTransaction(async client => {
      const inserted = await client.query(
        "INSERT INTO machines(name,machine_type) VALUES($1,$2) RETURNING id,code,name,machine_type,is_active",
        [parsed.data.name, parsed.data.machineType?.trim() || null]
      );
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "create",
        module: "production",
        entityType: "machine",
        entityId: inserted.rows[0].id,
        afterData: inserted.rows[0],
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.delete("/api/machines/:id", {
    preHandler: [authenticateRequest, requirePermission("machines.edit")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const row = await withTransaction(async client => {
      const current = await client.query("SELECT * FROM machines WHERE id=$1 FOR UPDATE", [id]);
      if (!current.rowCount) throw new AppError("MACHINE_NOT_FOUND", "الماكينة غير موجودة", 404);
      if (!current.rows[0].is_active) return current.rows[0];
      const updated = await client.query(
        "UPDATE machines SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,name,machine_type,is_active",
        [id]
      );
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "deactivate",
        module: "production",
        entityType: "machine",
        entityId: id,
        beforeData: current.rows[0],
        afterData: updated.rows[0],
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return updated.rows[0];
    });
    return { data: row };
  });

  app.get("/api/machine-production", {
    preHandler: [authenticateRequest, requirePermission("machine_production.view")]
  }, async () => {
    const result = await pool.query(
      `SELECT mp.id,mp.code,to_char(mp.work_date,'YYYY-MM-DD') AS work_date,
              mp.quantity,mp.status,mp.cancellation_reason,
              m.name AS machine_name,p.name AS product_name,
              e.full_name AS employee_name,po.code AS order_code,po.order_name,
              s.name AS stage_name,pt.name AS production_type_name
         FROM machine_productions mp
         JOIN machines m ON m.id=mp.machine_id
         JOIN products p ON p.id=mp.product_id
         LEFT JOIN employees e ON e.id=mp.employee_id
         LEFT JOIN shifts sh ON sh.id=mp.shift_id
         LEFT JOIN order_stages os ON os.id=mp.order_stage_id
         LEFT JOIN production_orders po ON po.id=os.order_id
         LEFT JOIN stages s ON s.id=os.stage_id
         LEFT JOIN production_types pt ON pt.id=mp.production_type_id
        ORDER BY mp.work_date DESC,mp.created_at DESC
        LIMIT 500`
    );
    return { data: result.rows };
  });

  app.post("/api/machine-production", {
    preHandler: [authenticateRequest, requirePermission("machine_production.create")]
  }, async (request, reply) => {
    const parsed = productionSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "راجع الماكينة والطلبية والمرحلة والتاريخ والكمية", 422);
    const row = await withTransaction(async client => {
      await assertAccountingPeriodOpen(client, parsed.data.workDate);
      const machine = await client.query(
        "SELECT id FROM machines WHERE id=$1 AND is_active=TRUE FOR SHARE",
        [parsed.data.machineId]
      );
      if (!machine.rowCount) throw new AppError("MACHINE_NOT_FOUND", "الماكينة غير موجودة أو غير نشطة", 422);
      const product = await client.query(
        "SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",
        [parsed.data.productId]
      );
      if (!product.rowCount) throw new AppError("PRODUCT_NOT_FOUND", "المنتج غير موجود أو غير نشط", 422);
      const employeeId = parsed.data.employeeId ?? null;
      if (employeeId) {
        const employee = await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE", [employeeId]);
        if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 422);
      }
      if (parsed.data.shiftId) {
        const shift = await client.query("SELECT id FROM shifts WHERE id=$1 AND is_active=TRUE", [parsed.data.shiftId]);
        if (!shift.rowCount) throw new AppError("SHIFT_NOT_FOUND", "الوردية غير موجودة أو غير نشطة", 422);
      }
      const stageRef = await client.query(
        "SELECT order_id FROM order_stages WHERE id=$1",
        [parsed.data.orderStageId]
      );
      if (!stageRef.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND", "مرحلة الطلبية غير موجودة", 422);
      const order = await client.query(
        "SELECT status FROM production_orders WHERE id=$1 FOR UPDATE",
        [stageRef.rows[0].order_id]
      );
      if (!order.rowCount || ["DRAFT","COMPLETED","CANCELLED"].includes(order.rows[0].status)) {
        throw new AppError("ORDER_NOT_ACTIVE", "لا يمكن تسجيل إنتاج ماكينة لطلبية مسودة أو مكتملة أو ملغاة", 409);
      }
      const stage = await client.query(
        `SELECT os.id,os.status,os.output_product_id,os.stage_id,po.status AS order_status
           FROM order_stages os JOIN production_orders po ON po.id=os.order_id
          WHERE os.id=$1 AND os.order_id=$2 FOR UPDATE OF os`,
        [parsed.data.orderStageId, stageRef.rows[0].order_id]
      );
      if (!stage.rowCount || ["CANCELLED","COMPLETED"].includes(stage.rows[0].status)) {
        throw new AppError("ORDER_STAGE_NOT_ACTIVE", "مرحلة الطلبية غير نشطة أو مكتملة", 409);
      }
      if (stage.rows[0].output_product_id !== parsed.data.productId) {
        throw new AppError("STAGE_PRODUCT_MISMATCH", "المنتج المختار لا يطابق المنتج الناتج المحدد للمرحلة", 422);
      }
      let productionTypeId = parsed.data.productionTypeId ?? null;
      if (productionTypeId) {
        const type = await client.query("SELECT id FROM production_types WHERE id=$1 AND is_active=TRUE", [productionTypeId]);
        if (!type.rowCount) throw new AppError("PRODUCTION_TYPE_NOT_FOUND", "نوع الإنتاج غير موجود أو غير نشط", 422);
      }
      const inserted = await client.query(
        `INSERT INTO machine_productions(
           order_stage_id,machine_id,product_id,production_type_id,employee_id,shift_id,
           work_date,quantity,unit_id,notes,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11)
         RETURNING id,code,to_char(work_date,'YYYY-MM-DD') AS work_date,quantity,status`,
        [parsed.data.orderStageId,parsed.data.machineId,parsed.data.productId,productionTypeId,employeeId,
         parsed.data.shiftId ?? null,parsed.data.workDate,parsed.data.quantity,product.rows[0].unit_id,
         parsed.data.notes.trim() || null,request.user!.userId]
      );
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "create",
        module: "production",
        entityType: "machine_production",
        entityId: inserted.rows[0].id,
        afterData: inserted.rows[0],
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.post("/api/machine-production/:id/cancel", {
    preHandler: [authenticateRequest, requirePermission("machine_production.cancel")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "أدخل كلمة المرور وسبب الإلغاء (٣ أحرف على الأقل)", 422);
    const row = await withTransaction(async client => {
      const actor = await client.query(
        "SELECT password_hash FROM users WHERE id=$1 AND is_active=TRUE",
        [request.user!.userId]
      );
      if (!actor.rowCount || !verifyPassword(parsed.data.password, actor.rows[0].password_hash)) {
        throw new AppError("INVALID_PASSWORD", "كلمة المرور غير صحيحة؛ لم يتم إلغاء السجل", 401);
      }
      const current = await client.query(
        `SELECT mp.*,to_char(mp.work_date,'YYYY-MM-DD') AS normalized_work_date
           FROM machine_productions mp WHERE mp.id=$1 FOR UPDATE`,
        [id]
      );
      if (!current.rowCount) throw new AppError("MACHINE_PRODUCTION_NOT_FOUND", "سجل إنتاج الماكينة غير موجود", 404);
      if (current.rows[0].status === "CANCELLED") {
        throw new AppError("ALREADY_CANCELLED", "سجل إنتاج الماكينة ملغى بالفعل", 409);
      }
      await assertAccountingPeriodOpen(client, current.rows[0].normalized_work_date);
      const stock = await client.query(
        `SELECT 1 FROM stock_movements
          WHERE reference_id=$1 AND reference_type IN ('MACHINE_PRODUCTION','MACHINE_PRODUCTION_REVERSAL')
          LIMIT 1 FOR SHARE`,
        [id]
      );
      const lots = await client.query(
        "SELECT 1 FROM inventory_lots WHERE source_id=$1 AND source_type='MACHINE_PRODUCTION' LIMIT 1 FOR SHARE",
        [id]
      );
      if (stock.rowCount || lots.rowCount) {
        throw new AppError("MACHINE_PRODUCTION_HAS_STOCK_EFFECTS", "السجل مرتبط بحركات مخزنية؛ لا يمكن إلغاؤه قبل تنفيذ عكس مخزني آمن", 409);
      }
      const updated = await client.query(
        `UPDATE machine_productions
            SET status='CANCELLED',cancelled_by=$1,cancelled_at=now(),cancellation_reason=$2
          WHERE id=$3
          RETURNING id,code,status,work_date,quantity,cancelled_at,cancellation_reason`,
        [request.user!.userId,parsed.data.reason,id]
      );
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "cancel",
        module: "production",
        entityType: "machine_production",
        entityId: id,
        beforeData: current.rows[0],
        afterData: updated.rows[0],
        metadata: { reason: parsed.data.reason },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return updated.rows[0];
    });
    return { data: row };
  });
}
