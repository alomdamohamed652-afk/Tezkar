import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { createInventoryLot } from "../warehouse/inventory-lots.service.js";

const createSchema = z.object({
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
                p.unit_id, p.quantity, p.status, e.full_name AS employee_name, pr.name AS product_name,
                os.order_id, os.status AS order_stage_status, po.status AS order_status
           FROM production_entries p
           JOIN employees e ON e.id=p.employee_id
           JOIN products pr ON pr.id=p.product_id
           LEFT JOIN order_stages os ON os.id=p.order_stage_id
           LEFT JOIN production_orders po ON po.id=os.order_id
          WHERE p.id=$1 FOR UPDATE OF p`,
        [input.productionEntryId]
      );
      if (!entry.rowCount) throw new AppError("PRODUCTION_NOT_FOUND", "سجل الإنتاج غير موجود", 404);
      if (entry.rows[0].status === "CANCELLED" || entry.rows[0].status === "REJECTED") {
        throw new AppError("PRODUCTION_NOT_ACTIVE", "لا يمكن تسجيل هالك على إنتاج ملغي أو مرفوض", 409);
      }
      if (entry.rows[0].order_id && ["DRAFT", "COMPLETED", "CANCELLED"].includes(entry.rows[0].order_status)) {
        throw new AppError("ORDER_NOT_ACTIVE", "لا يمكن تسجيل هالك على طلبية مسودة أو مكتملة أو ملغاة", 409);
      }
      if (entry.rows[0].order_stage_id && ["COMPLETED", "CANCELLED"].includes(entry.rows[0].order_stage_status)) {
        throw new AppError("ORDER_STAGE_LOCKED", "لا يمكن تسجيل هالك على مرحلة مكتملة أو ملغاة", 409);
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
          (production_entry_id, scrap_type, quantity, notes, recorded_by_user_id)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, production_entry_id, scrap_type, quantity, notes, created_at`,
        [input.productionEntryId, input.scrapType, input.quantity, input.notes ?? null, request.user!.userId]
      );
      // Keep the scrap record and its physical warehouse receipt atomic.
      // Scrap is tracked at zero inventory value so it does not inflate financial stock valuation.
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
              SET quantity=$1, inventory_value=$2, avg_unit_cost=CASE WHEN $1>0 THEN $2/$1 ELSE 0 END, updated_at=now()
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
      const movement = await client.query(
        `INSERT INTO stock_movements(
           movement_type, product_id, warehouse_id, location_id, quantity, unit_id,
           unit_cost, total_cost, order_id, order_stage_id, notes, created_by,
           reference_type, reference_id, scrap_origin_type, scrap_origin_reference
         )
         VALUES('IN',$1,$2,$3,$4,$5,0,0,$6,$7,$8,$9,'PRODUCTION_SCRAP',$10,'PRODUCTION',$11)
         RETURNING id`,
        [
          entry.rows[0].product_id, warehouseId, locationId, input.quantity, entry.rows[0].unit_id,
          entry.rows[0].order_id ?? null, entry.rows[0].order_stage_id ?? null,
          input.notes ?? `هالك مسجل على إنتاج ${entry.rows[0].code}`, request.user!.userId,
          result.rows[0].id,
          `${entry.rows[0].code} | ${entry.rows[0].employee_name} | ${entry.rows[0].product_name}`
        ]
      );
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
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId ?? null,
        action: "CREATE",
        module: "production",
        entityType: "production_scrap_record",
        entityId: result.rows[0].id,
        afterData: { ...result.rows[0], stockMovementId: movement.rows[0].id, scrapWarehouseId: warehouseId }
      });
      return { ...result.rows[0], stock_movement_id: movement.rows[0].id, employee_name: entry.rows[0].employee_name, product_name: entry.rows[0].product_name };
    });
    return reply.code(201).send({ data: created });
  });
}
