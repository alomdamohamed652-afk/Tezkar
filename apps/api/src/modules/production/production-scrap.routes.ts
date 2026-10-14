import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { createInventoryLot, consumeInventoryLots, adjustStockValueAfterLotConsumption } from "../warehouse/inventory-lots.service.js";

const createSchema = z.object({
  idempotencyKey: z.string().uuid(),
  productionEntryId: z.string().uuid(),
  scrapType: z.enum(["WORKER_SCRAP", "MANUFACTURING_DEFECT"]),
  quantity: z.number().positive().max(100000000),
  notes: z.string().trim().max(1000).nullable().optional()
});

export async function productionScrapRoutes(app: FastifyInstance) {
  app.get("/api/production/scrap", {
    preHandler: [authenticateRequest, requirePermission("production.view")]
  }, async (request) => {
    const q = z.object({
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      employeeId: z.string().uuid().optional(),
      orderId: z.string().uuid().optional(),
      scrapType: z.enum(["WORKER_SCRAP", "MANUFACTURING_DEFECT"]).optional()
    }).safeParse(request.query);
    if (!q.success) throw new AppError("VALIDATION_ERROR", "فلاتر الهالك غير صحيحة", 422);
    const values: unknown[] = [];
    const where: string[] = [];
    if (q.data.from) { values.push(q.data.from); where.push(`p.work_date >= $${values.length}`); }
    if (q.data.to) { values.push(q.data.to); where.push(`p.work_date <= $${values.length}`); }
    if (q.data.employeeId) { values.push(q.data.employeeId); where.push(`p.employee_id = $${values.length}`); }
    if (q.data.orderId) { values.push(q.data.orderId); where.push(`os.order_id = $${values.length}`); }
    if (q.data.scrapType) { values.push(q.data.scrapType); where.push(`s.scrap_type = $${values.length}`); }
    const result = await pool.query(
      `SELECT s.id, s.production_entry_id, s.scrap_type, s.quantity, s.notes, s.created_at,
              p.code AS production_code, p.work_date, p.quantity AS production_quantity,
              (SELECT COALESCE(SUM(sr.quantity),0) FROM production_scrap_records sr WHERE sr.production_entry_id=s.production_entry_id) AS scrap_total_for_entry, p.status,
              e.id AS employee_id, e.full_name AS employee_name,
              pr.name AS product_name, st.name AS stage_name, sh.name AS shift_name,
              o.code AS order_code, o.order_name
         FROM production_scrap_records s
         JOIN production_entries p ON p.id=s.production_entry_id
         JOIN employees e ON e.id=p.employee_id
         JOIN products pr ON pr.id=p.product_id
         JOIN stages st ON st.id=p.stage_id
         JOIN shifts sh ON sh.id=p.shift_id
         LEFT JOIN order_stages os ON os.id=p.order_stage_id
         LEFT JOIN production_orders o ON o.id=os.order_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY s.created_at DESC LIMIT 500`,
      values
    );
    const rows = result.rows.map((row) => ({
      ...row,
      scrap_ratio: Number(row.production_quantity) > 0 ? Number(row.scrap_total_for_entry) / Number(row.production_quantity) * 100 : 0
    }));
    return { data: rows };
  });

  app.post("/api/production/scrap", {
    preHandler: [authenticateRequest, requirePermission("production.create")]
  }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "راجع بيانات الهالك والكمية", 422);
    const input = parsed.data;
    const created = await withTransaction(async (client) => {
      const entry = await client.query(
        `SELECT p.id, p.code, p.employee_id, p.product_id, p.stage_id, p.order_stage_id, p.shift_id,
                p.unit_id, p.quantity, p.status, p.warehouse_id, p.location_id, e.full_name AS employee_name, pr.name AS product_name,
                os.order_id
           FROM production_entries p
           JOIN employees e ON e.id=p.employee_id
           JOIN products pr ON pr.id=p.product_id
           LEFT JOIN order_stages os ON os.id=p.order_stage_id
          WHERE p.id=$1 FOR UPDATE OF p`,
        [input.productionEntryId]
      );
      if (!entry.rowCount) throw new AppError("PRODUCTION_NOT_FOUND", "سجل الإنتاج غير موجود", 404);
      const idempotencyFingerprint = JSON.stringify({
        productionEntryId: input.productionEntryId,
        scrapType: input.scrapType,
        quantity: input.quantity,
        notes: input.notes ?? null
      });
      const lookupPriorScrap = () => client.query(
        `SELECT s.id, s.idempotency_fingerprint, s.production_entry_id, s.scrap_type, s.quantity, s.notes, s.created_at,
                p.code AS production_code, e.full_name AS employee_name, pr.name AS product_name,
                sm.id AS stock_movement_id, sm.warehouse_id AS scrap_warehouse_id,
                (SELECT sm2.id FROM stock_movements sm2 WHERE sm2.reference_type='TRANSFER' AND sm2.reference_id=sm.id LIMIT 1) AS source_stock_movement_id
           FROM production_scrap_records s
           JOIN production_entries p ON p.id=s.production_entry_id
           JOIN employees e ON e.id=p.employee_id
           JOIN products pr ON pr.id=p.product_id
           LEFT JOIN stock_movements sm ON sm.reference_type='PRODUCTION_SCRAP' AND sm.reference_id=s.id
          WHERE s.idempotency_key=$1`,
        [input.idempotencyKey]
      );
      const replayPriorScrap = (row: Record<string, unknown>) => {
        if (row.idempotency_fingerprint !== idempotencyFingerprint) {
          throw new AppError("IDEMPOTENCY_KEY_REUSED", "مفتاح الطلب استُخدم سابقًا لبيانات هالك مختلفة", 409);
        }
        return {
          id: row.id, production_entry_id: row.production_entry_id, scrap_type: row.scrap_type,
          quantity: row.quantity, notes: row.notes, created_at: row.created_at,
          stock_movement_id: row.stock_movement_id, source_stock_movement_id: row.source_stock_movement_id,
          scrap_warehouse_id: row.scrap_warehouse_id, production_code: row.production_code,
          employee_name: row.employee_name, product_name: row.product_name, idempotentReplay: true
        };
      };
      const priorScrap = await lookupPriorScrap();
      if (priorScrap.rowCount) return replayPriorScrap(priorScrap.rows[0] as Record<string, unknown>);
      if (!["PENDING", "APPROVED"].includes(entry.rows[0].status)) {
        throw new AppError("PRODUCTION_NOT_ACTIVE", "لا يمكن تسجيل هالك إلا على إنتاج قيد الاعتماد أو معتمد", 409);
      }
      const stockProduct = await client.query(
        "SELECT id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE FOR UPDATE",
        [entry.rows[0].product_id]
      );
      if (!stockProduct.rowCount) {
        throw new AppError("PRODUCT_NOT_INVENTORIED", "منتج الإنتاج غير موجود أو غير متابع مخزنيًا", 409);
      }
      if (entry.rows[0].order_stage_id) {
        const parent = await client.query(
          `SELECT os.status AS order_stage_status, po.status AS order_status
             FROM production_orders po
             JOIN order_stages os ON os.order_id=po.id
            WHERE os.id=$1
            ORDER BY po.id, os.id
            FOR UPDATE OF po, os`,
          [entry.rows[0].order_stage_id]
        );
        if (!parent.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND", "مرحلة الطلب غير موجودة", 404);
        if (["DRAFT", "COMPLETED", "CANCELLED"].includes(parent.rows[0].order_status)) {
          throw new AppError("ORDER_NOT_ACTIVE", "لا يمكن تسجيل هالك على طلبية مسودة أو مكتملة أو ملغاة", 409);
        }
        if (["COMPLETED", "CANCELLED"].includes(parent.rows[0].order_stage_status)) {
          throw new AppError("ORDER_STAGE_LOCKED", "لا يمكن تسجيل هالك على مرحلة مكتملة أو ملغاة", 409);
        }
      }
      const existingScrap = await client.query(
        "SELECT COALESCE(SUM(quantity),0) AS quantity FROM production_scrap_records WHERE production_entry_id=$1",
        [input.productionEntryId]
      );
      if (Number(existingScrap.rows[0].quantity) + input.quantity > Number(entry.rows[0].quantity) + 1e-9) {
        throw new AppError("SCRAP_EXCEEDS_PRODUCTION", "إجمالي الهالك لا يمكن أن يتجاوز كمية الإنتاج المسجلة", 422);
      }
      const result = await client.query(
        `INSERT INTO production_scrap_records
          (production_entry_id, scrap_type, quantity, notes, recorded_by_user_id, idempotency_key, idempotency_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, production_entry_id, scrap_type, quantity, notes, created_at`,
        [
          input.productionEntryId, input.scrapType, input.quantity, input.notes ?? null, request.user!.userId,
          input.idempotencyKey, idempotencyFingerprint
        ]
      );
      if (!result.rowCount) {
        const racedPriorScrap = await lookupPriorScrap();
        if (!racedPriorScrap.rowCount) {
          throw new AppError("IDEMPOTENCY_CONFLICT", "تعذر التحقق من نتيجة الطلب المكرر؛ أعد المحاولة بنفس المفتاح", 409);
        }
        return replayPriorScrap(racedPriorScrap.rows[0] as Record<string, unknown>);
      }
      const scrapDestination = await client.query(
        `SELECT w.id AS warehouse_id, l.id AS location_id
           FROM warehouses w
           JOIN warehouse_locations l ON l.warehouse_id=w.id AND l.is_active=TRUE
          WHERE w.warehouse_type='SCRAP' AND w.is_active=TRUE
          ORDER BY w.created_at ASC, w.id, l.code
          LIMIT 1
          FOR UPDATE OF w, l`
      );
      if (!scrapDestination.rowCount) {
        throw new AppError("SCRAP_WAREHOUSE_MISSING", "مخزن الهالك أو مكانه الداخلي غير مُعدّ. جهّز مخزن الهالك أولًا.", 409);
      }
      const warehouseId = scrapDestination.rows[0].warehouse_id as string;
      const locationId = scrapDestination.rows[0].location_id as string;
      const isApprovedProduction = entry.rows[0].status === "APPROVED";
      let sourceMovementId: string | null = null;
      if (isApprovedProduction) {
        const sourceWarehouseId = entry.rows[0].warehouse_id as string | null;
        const sourceLocationId = entry.rows[0].location_id as string | null;
        if (!sourceWarehouseId || !sourceLocationId) {
          throw new AppError("SCRAP_SOURCE_LOCATION_MISSING", "سجل الإنتاج المعتمد لا يحتوي على مخزن ومكان مصدر صالحين", 409);
        }
        if (sourceWarehouseId === warehouseId && sourceLocationId === locationId) {
          throw new AppError("SCRAP_SOURCE_EQUALS_DESTINATION", "لا يمكن تحويل الهالك من مخزن الهالك نفسه", 409);
        }
        const sourceBalance = await client.query(
          `SELECT quantity, inventory_value FROM stock_balances
            WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3
            FOR UPDATE`,
          [entry.rows[0].product_id, sourceWarehouseId, sourceLocationId]
        );
        const availableSourceQuantity = Number(sourceBalance.rows[0]?.quantity ?? 0);
        if (!sourceBalance.rowCount || availableSourceQuantity + 1e-9 < input.quantity) {
          throw new AppError("SCRAP_SOURCE_STOCK_INSUFFICIENT", "الرصيد المتاح في مخزن الإنتاج لا يكفي لتحويل كمية الهالك. قد تكون الكمية استُهلكت في مرحلة لاحقة.", 409);
        }
        const sourceLots = await client.query(
          `SELECT COALESCE(SUM(remaining_quantity),0) AS quantity
             FROM inventory_lots
            WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 AND remaining_quantity>0`,
          [entry.rows[0].product_id, sourceWarehouseId, sourceLocationId]
        );
        if (Math.abs(Number(sourceLots.rows[0]?.quantity ?? 0) - availableSourceQuantity) > 1e-7) {
          throw new AppError("INVENTORY_INTEGRITY_MISMATCH", "رصيد مخزن الإنتاج لا يطابق مجموع دفعات التكلفة؛ تم إيقاف تسجيل الهالك لحماية المخزون", 409);
        }
        const sourceMovement = await client.query(
          `INSERT INTO stock_movements(
             movement_type, product_id, warehouse_id, location_id, quantity, unit_id,
             unit_cost, total_cost, order_id, order_stage_id, notes, created_by,
             reference_type, scrap_origin_type, scrap_origin_reference
           )
           VALUES('TRANSFER_OUT',$1,$2,$3,$4,$5,0,0,$6,$7,$8,$9,'TRANSFER','PRODUCTION',$10)
           RETURNING id`,
          [
            entry.rows[0].product_id, sourceWarehouseId, sourceLocationId, input.quantity, entry.rows[0].unit_id,
            entry.rows[0].order_id ?? null, entry.rows[0].order_stage_id ?? null,
            "تحويل هالك من إنتاج " + entry.rows[0].code, request.user!.userId,
            `${entry.rows[0].code} | ${entry.rows[0].employee_name} | ${entry.rows[0].product_name}`
          ]
        );
        sourceMovementId = sourceMovement.rows[0].id as string;
        const consumed = await consumeInventoryLots(client, {
          movementId: sourceMovementId,
          productId: entry.rows[0].product_id,
          warehouseId: sourceWarehouseId,
          locationId: sourceLocationId,
          quantity: input.quantity
        });
        await client.query(
          "UPDATE stock_movements SET unit_cost=$1,total_cost=$2 WHERE id=$3",
          [consumed.unitCost, consumed.totalCost, sourceMovementId]
        );
        await client.query(
          `UPDATE stock_balances SET quantity=quantity-$1,updated_at=now()
            WHERE product_id=$2 AND warehouse_id=$3 AND location_id=$4`,
          [input.quantity, entry.rows[0].product_id, sourceWarehouseId, sourceLocationId]
        );
        await adjustStockValueAfterLotConsumption(
          client, entry.rows[0].product_id, sourceWarehouseId, sourceLocationId, consumed.totalCost
        );
      }

      const existingBalance = await client.query(
        `SELECT quantity, inventory_value
           FROM stock_balances
          WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3
          FOR UPDATE`,
        [entry.rows[0].product_id, warehouseId, locationId]
      );
      const oldQuantity = Number(existingBalance.rows[0]?.quantity ?? 0);
      const oldValue = Number(existingBalance.rows[0]?.inventory_value ?? 0);
      const nextQuantity = oldQuantity + input.quantity;
      if (existingBalance.rowCount) {
        await client.query(
          `UPDATE stock_balances
              SET quantity=$1, inventory_value=$2, avg_unit_cost=CASE WHEN $1::numeric>0 THEN $2/$1::numeric ELSE 0 END, updated_at=now()
            WHERE product_id=$3 AND warehouse_id=$4 AND location_id=$5`,
          [nextQuantity, oldValue, entry.rows[0].product_id, warehouseId, locationId]
        );
      } else {
        await client.query(
          `INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity,avg_unit_cost,inventory_value)
           VALUES($1,$2,$3,$4,0,0)`,
          [entry.rows[0].product_id, warehouseId, locationId, input.quantity]
        );
      }
      // Before approval, the physical scrap is recorded separately and the approval
      // workflow excludes it from good output. After approval, scrap is a real transfer
      // out of the good-stock balance, never an additional quantity on top of it.
      const movement = await client.query(
        `INSERT INTO stock_movements(
           movement_type, product_id, warehouse_id, location_id, quantity, unit_id,
           unit_cost, total_cost, order_id, order_stage_id, notes, created_by,
           reference_type, reference_id, scrap_origin_type, scrap_origin_reference
         )
         VALUES($1,$2,$3,$4,$5,$6,0,0,$7,$8,$9,$10,'PRODUCTION_SCRAP',$11,'PRODUCTION',$12)
         RETURNING id`,
        [
          isApprovedProduction ? "TRANSFER_IN" : "IN",
          entry.rows[0].product_id, warehouseId, locationId, input.quantity, entry.rows[0].unit_id,
          entry.rows[0].order_id ?? null, entry.rows[0].order_stage_id ?? null,
          input.notes ?? `هالك مسجل على إنتاج ${entry.rows[0].code}`, request.user!.userId,
          result.rows[0].id,
          `${entry.rows[0].code} | ${entry.rows[0].employee_name} | ${entry.rows[0].product_name}`
        ]
      );
      if (sourceMovementId) {
        await client.query("UPDATE stock_movements SET reference_id=$1 WHERE id=$2", [movement.rows[0].id, sourceMovementId]);
      }
      await createInventoryLot(client, {
        productId: entry.rows[0].product_id,
        warehouseId,
        locationId,
        quantity: input.quantity,
        unitCost: 0,
        batchCode: entry.rows[0].code,
        sourceType: "PRODUCTION_SCRAP",
        sourceId: movement.rows[0].id
      });
      if (isApprovedProduction && entry.rows[0].order_stage_id) {
        const stageUpdate = await client.query(
          `UPDATE order_stages
              SET completed_quantity=GREATEST(0,completed_quantity-$1),
                  status=CASE
                    WHEN planned_quantity IS NOT NULL AND GREATEST(0,completed_quantity-$1)>=planned_quantity THEN 'COMPLETED'
                    WHEN GREATEST(0,completed_quantity-$1)=0 THEN 'PENDING'
                    ELSE 'IN_PROGRESS'
                  END,
                  completed_at=CASE
                    WHEN planned_quantity IS NOT NULL AND GREATEST(0,completed_quantity-$1)>=planned_quantity THEN completed_at
                    WHEN GREATEST(0,completed_quantity-$1)=0 THEN NULL
                    ELSE completed_at
                  END
            WHERE id=$2
            RETURNING id,order_id,completed_quantity,status`,
          [input.quantity, entry.rows[0].order_stage_id]
        );
        if (!stageUpdate.rowCount) {
          throw new AppError("ORDER_STAGE_NOT_FOUND", "مرحلة الطلب المرتبطة بالإنتاج غير موجودة", 409);
        }
      }
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId ?? null,
        action: "CREATE",
        module: "production",
        entityType: "production_scrap_record",
        entityId: result.rows[0].id,
        afterData: { ...result.rows[0], stockMovementId: movement.rows[0].id, sourceStockMovementId: sourceMovementId, scrapWarehouseId: warehouseId }
      });
      return { ...result.rows[0], stock_movement_id: movement.rows[0].id, source_stock_movement_id: sourceMovementId, employee_name: entry.rows[0].employee_name, product_name: entry.rows[0].product_name, idempotentReplay: false };
    });
    return reply.code(created.idempotentReplay ? 200 : 201).send({ data: created });
  });
}
