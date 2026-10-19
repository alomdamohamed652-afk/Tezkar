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
        `SELECT mp.*,os.order_id,to_char(mp.work_date,'YYYY-MM-DD') AS normalized_work_date
           FROM machine_productions mp
           LEFT JOIN order_stages os ON os.id=mp.order_stage_id
          WHERE mp.id=$1 FOR UPDATE OF mp`,
        [id]
      );
      if (!current.rowCount) throw new AppError("MACHINE_PRODUCTION_NOT_FOUND", "سجل إنتاج الماكينة غير موجود", 404);
      if (current.rows[0].status === "CANCELLED") {
        throw new AppError("ALREADY_CANCELLED", "سجل إنتاج الماكينة ملغى بالفعل", 409);
      }
      await assertAccountingPeriodOpen(client, current.rows[0].normalized_work_date);
      const lotResult = await client.query(
        `SELECT id,product_id,warehouse_id,location_id,unit_cost,original_quantity,remaining_quantity
           FROM inventory_lots WHERE source_id=$1 AND source_type='MACHINE_PRODUCTION'
          ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [id]
      );
      if (lotResult.rowCount) {
        const lot=lotResult.rows[0];
        const originalQty=Number(lot.original_quantity);
        const remainingQty=Number(lot.remaining_quantity);
        if (Math.abs(remainingQty-originalQty)>0.0005) {
          throw new AppError("MACHINE_PRODUCTION_STOCK_ALREADY_USED","لا يمكن التراجع عن الإنتاج لأن جزءًا منه تم صرفه أو استهلاكه. عالج الحركات التابعة أولًا.",409);
        }
        const balance=await client.query(
          "SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
          [lot.product_id,lot.warehouse_id,lot.location_id]
        );
        if (!balance.rowCount || Number(balance.rows[0].quantity)+0.0005<originalQty) {
          throw new AppError("MACHINE_PRODUCTION_STOCK_BALANCE_CHANGED","الرصيد الحالي لا يسمح بعكس كمية إنتاج الماكينة كاملة",409);
        }
        const nextQty=Number(balance.rows[0].quantity)-originalQty;
        const removedValue=Number(lot.unit_cost)*originalQty;
        const nextValue=Math.max(0,Number(balance.rows[0].inventory_value)-removedValue);
        const nextAvg=nextQty>0?nextValue/nextQty:0;
        await client.query(
          "UPDATE stock_balances SET quantity=$1,inventory_value=$2,avg_unit_cost=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",
          [nextQty,nextValue,nextAvg,lot.product_id,lot.warehouse_id,lot.location_id]
        );
        const reversal=await client.query(
          `INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,order_id,order_stage_id,notes,created_by,reference_type,reference_id)
           VALUES('OUT',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'MACHINE_PRODUCTION_REVERSAL',$12) RETURNING id`,
          [lot.product_id,lot.warehouse_id,lot.location_id,originalQty,current.rows[0].unit_id,lot.unit_cost,removedValue,current.rows[0].order_id??null,current.rows[0].order_stage_id??null,"عكس إنتاج ماكينة "+current.rows[0].code+" — "+parsed.data.reason,request.user!.userId,id]
        );
        await client.query(
          "INSERT INTO stock_movement_lots(movement_id,lot_id,quantity,unit_cost,total_cost) VALUES($1,$2,$3,$4,$5)",
          [reversal.rows[0].id,lot.id,originalQty,lot.unit_cost,removedValue]
        );
        await client.query("UPDATE inventory_lots SET remaining_quantity=0,updated_at=now() WHERE id=$1",[lot.id]);
      }
      if (current.rows[0].order_stage_id) {
        await client.query(
          `UPDATE order_stages
              SET completed_quantity=GREATEST(0,completed_quantity-$1),
                  status=CASE WHEN status='COMPLETED' AND planned_quantity IS NOT NULL AND GREATEST(0,completed_quantity-$1)<planned_quantity THEN 'IN_PROGRESS' ELSE status END,
                  completed_at=CASE WHEN status='COMPLETED' AND planned_quantity IS NOT NULL AND GREATEST(0,completed_quantity-$1)<planned_quantity THEN NULL ELSE completed_at END
            WHERE id=$2`,
          [Number(current.rows[0].quantity),current.rows[0].order_stage_id]
        );
        await client.query("UPDATE production_orders SET status='IN_PROGRESS',updated_at=now() WHERE id=$1 AND status='COMPLETED'",[current.rows[0].order_id]);
      }
      const updated = await client.query(`
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
