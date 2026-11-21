import type { FastifyInstance } from "fastify";
import { env } from "../../config.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { inspectDatabaseTransfer } from "./data-transfer-inspection.service.js";
import { checkDataTransferRateLimit } from "./data-transfer-rate-limit.js";
import { inspectSelectedTableCounts, parseRequestedTables, type RequestedTable } from "./data-transfer-counts.service.js";

export async function dataTransferRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/data-transfer/inspection", {
    preHandler: [authenticateRequest, requirePermission("system.backup.export")]
  }, async (request, reply) => {
    if (!env.TARGET_DATABASE_URL) {
      return reply.code(503).header("cache-control", "no-store, private").send({
        error: {
          code: "TARGET_DATABASE_NOT_CONFIGURED",
          message: "قاعدة البيانات الهدف غير مُعدة على خدمة API؛ لم يتم بدء الفحص."
        }
      });
    }

    const retryAfterMs = checkDataTransferRateLimit("inspection:" + request.user!.userId);
    if (retryAfterMs > 0) {
      return reply.code(429).header("cache-control", "no-store, private").header("retry-after", String(Math.ceil(retryAfterMs / 1000))).send({ error: { code: "DATA_TRANSFER_RATE_LIMITED", message: "تم تنفيذ فحص مؤخرًا. انتظر قليلًا قبل إعادة المحاولة." } });
    }

    try {
      const report = await inspectDatabaseTransfer(env.DATABASE_URL, env.TARGET_DATABASE_URL!);
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
  app.get("/api/admin/data-transfer/counts", {
    preHandler: [authenticateRequest, requirePermission("system.backup.export")]
  }, async (request, reply) => {
    if (!env.TARGET_DATABASE_URL) {
      return reply.code(503).header("cache-control", "no-store, private").send({
        error: { code: "TARGET_DATABASE_NOT_CONFIGURED", message: "قاعدة البيانات الهدف غير مُعدة؛ لم يبدأ فحص الأعداد." }
      });
    }

    let tables: RequestedTable[];
    try {
      const query = request.query as { tables?: unknown };
      tables = parseRequestedTables(query.tables);
    } catch (error) {
      return reply.code(400).header("cache-control", "no-store, private").send({
        error: {
          code: "INVALID_TABLE_SELECTION",
          message: error instanceof Error ? error.message : "اختيار الجداول غير صالح."
        }
      });
    }

    const retryAfterMs = checkDataTransferRateLimit("counts:" + request.user!.userId);
    if (retryAfterMs > 0) {
      return reply.code(429).header("cache-control", "no-store, private").header("retry-after", String(Math.ceil(retryAfterMs / 1000))).send({ error: { code: "DATA_TRANSFER_RATE_LIMITED", message: "تم تنفيذ فحص الأعداد مؤخرًا. انتظر قليلًا قبل إعادة المحاولة." } });
    }

    try {
      const report = await inspectSelectedTableCounts(env.DATABASE_URL, env.TARGET_DATABASE_URL!, tables);
      return reply.header("cache-control", "no-store, private").send(report);
    } catch (error) {
      app.log.error({ err: error }, "Read-only selected table count inspection failed");
      return reply.code(503).header("cache-control", "no-store, private").send({
        error: { code: "DATA_TRANSFER_COUNTS_FAILED", message: "تعذر فحص أعداد الجداول المحددة." }
      });
    }
  });
}
