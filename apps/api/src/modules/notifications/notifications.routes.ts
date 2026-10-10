import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/api/notifications", { preHandler: [authenticateRequest] }, async (request) => {
    const q = z.object({ unreadOnly: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(request.query);
    if (!q.success) throw new AppError("VALIDATION_ERROR", "فلاتر الإشعارات غير صحيحة", 422);
    const values: unknown[] = [request.user!.userId];
    const where = ["recipient_user_id=$1"];
    if (q.data.unreadOnly) where.push("read_at IS NULL");
    values.push(q.data.limit);
    const result = await pool.query(
      `SELECT id,notification_type,title,body,entity_type,entity_id,read_at,created_at
         FROM user_notifications WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC LIMIT $2`, values);
    const unread = await pool.query("SELECT COUNT(*)::int AS count FROM user_notifications WHERE recipient_user_id=$1 AND read_at IS NULL", [request.user!.userId]);
    return { data: result.rows, unreadCount: unread.rows[0].count };
  });

  app.post("/api/notifications/:id/read", { preHandler: [authenticateRequest] }, async (request) => {
    const id = (request.params as { id: string }).id;
    const result = await pool.query(
      "UPDATE user_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_user_id=$2 RETURNING id,read_at",
      [id, request.user!.userId]);
    if (!result.rowCount) throw new AppError("NOTIFICATION_NOT_FOUND", "الإشعار غير موجود", 404);
    return { data: result.rows[0] };
  });

  app.post("/api/notifications/read-all", { preHandler: [authenticateRequest] }, async (request) => {
    const result = await pool.query(
      "UPDATE user_notifications SET read_at=now() WHERE recipient_user_id=$1 AND read_at IS NULL",
      [request.user!.userId]);
    return { data: { updated: result.rowCount ?? 0 } };
  });
}
