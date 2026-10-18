import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { verifyPassword } from "../auth/auth.service.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";

const cancelSchema = z.object({
  password: z.string().min(1).max(200),
  reason: z.string().trim().min(3).max(500)
});

export async function machineProductionCancellationRoutes(app: FastifyInstance) {
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
