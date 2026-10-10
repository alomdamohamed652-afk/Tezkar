import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/api/notifications", { preHandler: [authenticateRequest] }, async (request) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(40) }).safeParse(request.query);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "عدد الإشعارات غير صحيح", 422);
    const result = await pool.query(
      `SELECT id,notification_type,title,body,href,entity_type,entity_id,read_at,created_at
         FROM user_notifications WHERE user_id=$1
        ORDER BY created_at DESC LIMIT $2`,
      [request.user!.userId, parsed.data.limit]
    );
    const count = await pool.query("SELECT COUNT(*)::int AS unread_count FROM user_notifications WHERE user_id=$1 AND read_at IS NULL", [request.user!.userId]);
    return { data: result.rows, unreadCount: count.rows[0]?.unread_count ?? 0 };
  });

  app.post("/api/notifications/:id/read", { preHandler: [authenticateRequest] }, async (request) => {
    const id = (request.params as { id: string }).id;
    const result = await pool.query(
      "UPDATE user_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at",
      [id, request.user!.userId]
    );
    if (!result.rowCount) throw new AppError("NOTIFICATION_NOT_FOUND", "الإشعار غير موجود", 404);
    return { data: result.rows[0] };
  });

  app.post("/api/notifications/read-all", { preHandler: [authenticateRequest] }, async (request) => {
    const result = await withTransaction(async (client) => client.query(
      "UPDATE user_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL RETURNING id",
      [request.user!.userId]
    ));
    return { data: { markedRead: result.rowCount ?? 0 } };
  });
}
