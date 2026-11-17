import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { createDatabaseBackup } from "./backup-database.service.js";

const exportSchema = z.object({ password: z.string().min(12).max(200) });

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/system-backups/export", {
    preHandler: [authenticateRequest, requirePermission("system.backup.export")]
  }, async (request, reply) => {
    const parsed = exportSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "كلمة مرور النسخة يجب أن تكون 12 حرفًا على الأقل", 422);
    let archive: Buffer;
    try {
      archive = await createDatabaseBackup(pool, parsed.data.password);
    } catch (error) {
      request.log.error({ err: error }, "System backup export failed");
      throw new AppError("BACKUP_EXPORT_FAILED", error instanceof Error ? error.message : "تعذر إنشاء النسخة الاحتياطية", 422);
    }
    await withTransaction(async client => {
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "export",
        module: "system",
        entityType: "system_backup",
        metadata: { formatVersion: 1, bytes: archive.length },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
    });
    return reply
      .header("content-type", "application/vnd.tezkar.backup")
      .header("content-disposition", 'attachment; filename="tezkar-backup.tzk"')
      .header("cache-control", "no-store, private")
      .header("x-content-type-options", "nosniff")
      .send(archive);
  });
}
