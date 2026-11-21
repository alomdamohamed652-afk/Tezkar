import type { FastifyInstance } from "fastify";
import { env } from "../../config.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { inspectDatabaseTransfer } from "./data-transfer-inspection.service.js";

export async function dataTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/data-transfer/inspection", {
    preHandler: [authenticateRequest, requirePermission("system.backup.export")]
  }, async (_request, reply) => {
    if (!env.LEGACY_DATABASE_URL) {
      return reply.code(503).header("cache-control", "no-store, private").send({
        error: {
          code: "LEGACY_DATABASE_NOT_CONFIGURED",
          message: "قاعدة البيانات القديمة غير مُعدة على خدمة API؛ لم يتم بدء الفحص."
        }
      });
    }

    try {
      const report = await inspectDatabaseTransfer(env.LEGACY_DATABASE_URL, env.DATABASE_URL);
      return reply.header("cache-control", "no-store, private").send(report);
    } catch (error) {
      app.log.error({ err: error }, "Read-only database transfer inspection failed");
      return reply.code(503).header("cache-control", "no-store, private").send({
        error: {
          code: "DATA_TRANSFER_INSPECTION_FAILED",
          message: "تعذر فحص قاعدتي البيانات. راجع سجل خدمة API لمعرفة السبب."
        }
      });
    }
  });
}
