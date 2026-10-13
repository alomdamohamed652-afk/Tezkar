import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/api/notifications", { preHandler: [authenticateRequest] }, async request => {
    const result = await pool.query(
      "SELECT id,type,title,message,entity_type,entity_id,created_at,read_at FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
      [request.user!.userId]
    );
    const unread = await pool.query(
      "SELECT count(*)::int AS count FROM user_notifications WHERE user_id=$1 AND read_at IS NULL",
      [request.user!.userId]
    );
    return { data: result.rows, unreadCount: unread.rows[0].count };
  });

  app.patch("/api/notifications/:id/read", { preHandler: [authenticateRequest] }, async request => {
    const id = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!id.success) throw new AppError("VALIDATION_ERROR", "معرّف الإشعار غير صحيح", 422);
    const result = await pool.query(
      "UPDATE user_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at",
      [id.data, request.user!.userId]
    );
    if (!result.rowCount) throw new AppError("NOTIFICATION_NOT_FOUND", "الإشعار غير موجود", 404);
    return { data: result.rows[0] };
  });

  app.post("/api/notifications/read-all", { preHandler: [authenticateRequest] }, async request => {
    const result = await pool.query(
      "UPDATE user_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",
      [request.user!.userId]
    );
    return { data: { updated: result.rowCount ?? 0 } };
  });
}
