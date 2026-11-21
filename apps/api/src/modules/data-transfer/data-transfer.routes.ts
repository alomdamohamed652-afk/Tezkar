import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { inspectLegacyAndTarget } from "./data-transfer.service.js";

export async function dataTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/data-transfer/inspection", {
    preHandler: [authenticateRequest, requirePermission("system.backup.restore")]
  }, async (_request, reply) => {
    reply.header("cache-control", "no-store, private");
    if (!process.env.LEGACY_DATABASE_URL) {
      return reply.code(503).send({
        error: { code: "LEGACY_DATABASE_NOT_CONFIGURED", message: "اتصال قاعدة البيانات القديمة غير مُعدّ" }
      });
    }
    try {
      const report = await inspectLegacyAndTarget(pool);
      return reply.send(report);
    } catch (error) {
      app.log.error({ err: error }, "Legacy database inspection failed");
      return reply.code(503).send({
        error: { code: "DATA_TRANSFER_INSPECTION_FAILED", message: "تعذر فحص القاعدتين؛ راجع اتصال المصدر ومخطط القاعدة" }
      });
    }
  });
}
