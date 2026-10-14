import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

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
              p.code AS production_code, p.work_date, p.quantity AS production_quantity, p.status,
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
         LEFT JOIN orders o ON o.id=os.order_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY s.created_at DESC LIMIT 500`,
      values
    );
    const rows = result.rows.map((row) => ({
      ...row,
      scrap_ratio: Number(row.production_quantity) > 0 ? Number(row.quantity) / Number(row.production_quantity) * 100 : 0
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
        `SELECT p.id, p.employee_id, p.product_id, p.stage_id, p.order_stage_id, p.shift_id,
                p.quantity, p.status, e.full_name AS employee_name, pr.name AS product_name
           FROM production_entries p
           JOIN employees e ON e.id=p.employee_id
           JOIN products pr ON pr.id=p.product_id
          WHERE p.id=$1 FOR UPDATE OF p`,
        [input.productionEntryId]
      );
      if (!entry.rowCount) throw new AppError("PRODUCTION_NOT_FOUND", "سجل الإنتاج غير موجود", 404);
      if (entry.rows[0].status === "CANCELLED" || entry.rows[0].status === "REJECTED") {
        throw new AppError("PRODUCTION_NOT_ACTIVE", "لا يمكن تسجيل هالك على إنتاج ملغي أو مرفوض", 409);
      }
      const result = await client.query(
        `INSERT INTO production_scrap_records
          (production_entry_id, scrap_type, quantity, notes, recorded_by_user_id)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, production_entry_id, scrap_type, quantity, notes, created_at`,
        [input.productionEntryId, input.scrapType, input.quantity, input.notes ?? null, request.user!.userId]
      );
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId ?? null,
        action: "CREATE",
        module: "production",
        entityType: "production_scrap_record",
        entityId: result.rows[0].id,
        afterData: result.rows[0]
      });
      return { ...result.rows[0], employee_name: entry.rows[0].employee_name, product_name: entry.rows[0].product_name };
    });
    return reply.code(201).send({ data: created });
  });
}
