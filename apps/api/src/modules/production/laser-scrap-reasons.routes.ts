import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const reasonSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(120)
});

async function audit(client: any, request: any, action: string, id: string, afterData: unknown) {
  await writeAudit(client, {
    actorUserId: request.user!.userId,
    actorEmployeeId: request.user!.employeeId,
    action,
    module: "machine_production",
    entityType: "laser_scrap_reason",
    entityId: id,
    afterData,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null
  });
}

export async function laserScrapReasonRoutes(app: FastifyInstance) {
  app.get("/api/laser-scrap-reasons", {
    preHandler: [authenticateRequest, requirePermission("machine_production.view")]
  }, async () => {
    const result = await pool.query(`
      SELECT id,code,name,status,created_at,updated_at
      FROM laser_scrap_reasons
      ORDER BY CASE WHEN status='ACTIVE' THEN 0 ELSE 1 END,name,code
    `);
    return { data: result.rows };
  });

  app.post("/api/laser-scrap-reasons", {
    preHandler: [authenticateRequest, requirePermission("machine_production.scrap_reasons.manage")]
  }, async (request, reply) => {
    const parsed = reasonSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "أدخل كود سبب هالك صحيحًا واسمًا واضحًا", 422);
    const result = await withTransaction(async client => {
      const duplicate = await client.query(
        "SELECT id FROM laser_scrap_reasons WHERE code=$1 OR lower(trim(name))=lower(trim($2)) LIMIT 1",
        [parsed.data.code,parsed.data.name]
      );
      if (duplicate.rowCount) throw new AppError("SCRAP_REASON_EXISTS", "كود سبب الهالك أو اسمه مستخدم بالفعل", 409);
      const inserted = await client.query(`
        INSERT INTO laser_scrap_reasons(code,name,created_by,updated_by)
        VALUES($1,$2,$3,$3) RETURNING id,code,name,status,created_at,updated_at
      `, [parsed.data.code,parsed.data.name,request.user!.userId]);
      await audit(client,request,"create_scrap_reason",inserted.rows[0].id,inserted.rows[0]);
      return inserted.rows[0];
    });
    return reply.code(201).send({ data: result });
  });

  app.patch("/api/laser-scrap-reasons/:id/archive", {
    preHandler: [authenticateRequest, requirePermission("machine_production.scrap_reasons.manage")]
  }, async request => {
    const id = (request.params as { id: string }).id;
    const result = await withTransaction(async client => {
      const updated = await client.query(`
        UPDATE laser_scrap_reasons SET status='ARCHIVED',updated_by=$2,updated_at=now()
        WHERE id=$1 AND status='ACTIVE'
        RETURNING id,code,name,status,updated_at
      `, [id,request.user!.userId]);
      if (!updated.rowCount) throw new AppError("SCRAP_REASON_NOT_FOUND", "سبب الهالك غير موجود أو مؤرشف بالفعل", 404);
      await audit(client,request,"archive_scrap_reason",id,updated.rows[0]);
      return updated.rows[0];
    });
    return { data: result };
  });
}
