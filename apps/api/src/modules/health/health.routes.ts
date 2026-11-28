import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { getAdminHealth } from "./admin-health.service.js";

async function assertSystemManager(userId: string) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.code = 'manager'
         AND r.is_system = TRUE AND r.is_active = TRUE
     ) AS allowed`,
    [userId]
  );
  if (!result.rows[0]?.allowed) {
    throw new AppError("HEALTH_ADMIN_REQUIRED", "صفحة صحة النظام متاحة لمدير النظام فقط", 403);
  }
}

export async function healthRoutes(app: FastifyInstance) {
  const handler = async () => {
    try {
      const result = await pool.query("SELECT 1 AS ok");
      return {
        status: "ok",
        database: result.rows[0]?.ok === 1 ? "ok" : "unknown"
      };
    } catch {
      return {
        status: "degraded",
        database: "down"
      };
    }
  };

  app.get("/health", handler);
  app.get("/api/health", handler);

  // Live system health for the system manager only: DB latency, last
  // migration, last backup, failed logins, recent server errors.
  app.get("/api/health/admin", { preHandler: [authenticateRequest] }, async request => {
    await assertSystemManager(request.user!.userId);
    return getAdminHealth();
  });
}
