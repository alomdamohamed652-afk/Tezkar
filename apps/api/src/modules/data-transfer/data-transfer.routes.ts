import type { FastifyInstance } from "fastify";
import { env } from "../../config.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { inspectDatabaseTransfer } from "./data-transfer-inspection.service.js";

export async function dataTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/data-transfer/inspection", {
    preHandler: [authenticateRequest, requirePermission("system.backup.export")],
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } }
  }, async (_request, reply) => {
    if (!env.LEGACY_DATABASE_URL) {
      throw new AppError("LEGACY_DATABASE_NOT_CONFIGURED", "قاعدة البيانات القديمة غير مُعدة على خدمة API؛ لم يتم بدء الفحص.", 503);
    }
    try {
      const report = await inspectDatabaseTransfer(env.LEGACY_DATABASE_URL, env.DATABASE_URL);
      return reply.header("cache-control", "no-store, private").send(report);
    } catch (error) {
      app.log.error({ err: error }, "Read-only database transfer inspection failed");
      throw new AppError("DATA_TRANSFER_INSPECTION_FAILED", error instanceof Error ? error.message : "تعذر فحص قاعدتي البيانات", 503);
    }
  });
}
