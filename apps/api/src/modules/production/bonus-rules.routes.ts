import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const ruleSchema = z.object({
  name: z.string().trim().min(2).max(120),
  stageId: z.string().uuid(),
  productId: z.string().uuid().nullable().optional(),
  minQuantity: z.number().positive().max(100000000),
  bonusAmount: z.number().positive().max(100000000),
  description: z.string().trim().min(2).max(500),
  isActive: z.boolean().optional()
});

const SELECT = `SELECT r.id,r.name,r.stage_id,s.name AS stage_name,r.product_id,r.scope,r.min_quantity::text AS min_quantity,r.bonus_amount::text AS bonus_amount,
  r.description,r.is_active,r.created_at,r.updated_at FROM production_bonus_rules r JOIN stages s ON s.id=r.stage_id`;

export async function productionBonusRuleRoutes(app: FastifyInstance) {
  app.get("/api/production/bonus-rules", { preHandler: [authenticateRequest, requirePermission("production.bonus_rules.view")] }, async () => {
    return { data: (await pool.query(`${SELECT} ORDER BY r.is_active DESC,s.name,r.min_quantity`)).rows };
  });

  app.post("/api/production/bonus-rules", { preHandler: [authenticateRequest, requirePermission("production.bonus_rules.manage")] }, async (request, reply) => {
    const p = ruleSchema.safeParse(request.body);
    if (!p.success) throw new AppError("VALIDATION_ERROR", "بيانات قاعدة البونص غير صحيحة", 422);
    const row = await withTransaction(async client => {
      const created = (await client.query(
        `INSERT INTO production_bonus_rules(name,stage_id,product_id,min_quantity,bonus_amount,description,is_active,created_by)
         VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,TRUE),$8) RETURNING *`,
        [p.data.name, p.data.stageId, p.data.productId ?? null, p.data.minQuantity, p.data.bonusAmount, p.data.description, p.data.isActive ?? null, request.user!.userId]
      )).rows[0];
      await writeAudit(client, { actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId, action: "create", module: "production", entityType: "production_bonus_rule", entityId: created.id, afterData: created, ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null });
      return created;
    });
    return reply.code(201).send({ data: row });
  });

  app.patch("/api/production/bonus-rules/:id", { preHandler: [authenticateRequest, requirePermission("production.bonus_rules.manage")] }, async (request) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    const p = ruleSchema.partial().safeParse(request.body);
    if (!id.success || !p.success) throw new AppError("VALIDATION_ERROR", "بيانات قاعدة البونص غير صحيحة", 422);
    return withTransaction(async client => {
      const before = (await client.query("SELECT * FROM production_bonus_rules WHERE id=$1 FOR UPDATE", [id.data])).rows[0];
      if (!before) throw new AppError("BONUS_RULE_NOT_FOUND", "قاعدة البونص غير موجودة", 404);
      const d = p.data;
      const after = (await client.query(
        `UPDATE production_bonus_rules SET name=$2,stage_id=$3,product_id=$4,min_quantity=$5,bonus_amount=$6,description=$7,is_active=$8,updated_at=now() WHERE id=$1 RETURNING *`,
        [id.data, d.name ?? before.name, d.stageId ?? before.stage_id, d.productId === undefined ? before.product_id : d.productId, d.minQuantity ?? before.min_quantity, d.bonusAmount ?? before.bonus_amount, d.description ?? before.description, d.isActive ?? before.is_active]
      )).rows[0];
      await writeAudit(client, { actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId, action: "edit", module: "production", entityType: "production_bonus_rule", entityId: id.data, beforeData: before, afterData: after, ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null });
      return { data: after };
    });
  });

  app.delete("/api/production/bonus-rules/:id", { preHandler: [authenticateRequest, requirePermission("production.bonus_rules.manage")] }, async (request) => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) throw new AppError("VALIDATION_ERROR", "معرّف القاعدة غير صحيح", 422);
    return withTransaction(async client => {
      const before = (await client.query("DELETE FROM production_bonus_rules WHERE id=$1 RETURNING *", [id.data])).rows[0];
      if (!before) throw new AppError("BONUS_RULE_NOT_FOUND", "قاعدة البونص غير موجودة", 404);
      // Adjustments already created by the rule stay (their bonus_rule_id becomes null); only future records are affected.
      await writeAudit(client, { actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId, action: "delete", module: "production", entityType: "production_bonus_rule", entityId: id.data, beforeData: before, ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null });
      return { data: { id: id.data, deleted: true } };
    });
  });
}

/** Best matching active PER_RECORD rule for one production record: the highest threshold that the quantity reaches. */
export async function findAutoBonusRule(client: import("pg").PoolClient, input: { stageId: string; productId: string; quantity: number }) {
  const r = await client.query(
    `SELECT id,bonus_amount::float8 AS bonus_amount,description FROM production_bonus_rules
      WHERE is_active AND scope='PER_RECORD' AND stage_id=$1 AND (product_id IS NULL OR product_id=$2) AND min_quantity <= $3::numeric
      ORDER BY min_quantity DESC, (product_id IS NULL), created_at DESC LIMIT 1`,
    [input.stageId, input.productId, input.quantity]
  );
  return (r.rows[0] as { id: string; bonus_amount: number; description: string } | undefined) ?? null;
}
