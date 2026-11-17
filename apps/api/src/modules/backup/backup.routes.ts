import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { createDatabaseBackup } from "./backup-database.service.js";
import { readBackupArchive } from "./backup-archive.js";
import { restoreBackupIntoCurrentDatabase } from "./backup-restore.service.js";

const exportSchema = z.object({ password: z.string().min(12).max(200) });
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function getRestorePassword(request: { headers: Record<string, string | string[] | undefined> }): string {
  const value = request.headers["x-backup-password"];
  if (typeof value !== "string" || value.length < 12 || value.length > 200) {
    throw new AppError("VALIDATION_ERROR", "أرسل كلمة مرور النسخة في ترويسة X-Backup-Password (12 حرفًا على الأقل)", 422);
  }
  return value;
}

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/vnd.tezkar.backup", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

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
    const auditClient = await pool.connect();
    try {
      await auditClient.query("BEGIN");
      await writeAudit(auditClient, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "export",
        module: "system",
        entityType: "system_backup",
        metadata: { formatVersion: 1, bytes: archive.length },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      await auditClient.query("COMMIT");
    } catch (error) {
      await auditClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      auditClient.release();
    }
    return reply
      .header("content-type", "application/vnd.tezkar.backup")
      .header("content-disposition", 'attachment; filename="tezkar-backup.tzk"')
      .header("cache-control", "no-store, private")
      .header("x-content-type-options", "nosniff")
      .send(archive);
  });

  const restoreHandler = (dryRun: boolean) => async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0 || request.body.length > MAX_ARCHIVE_BYTES + 4096) {
      throw new AppError("INVALID_BACKUP_FILE", "ملف النسخة غير صالح أو حجمه غير مسموح", 422);
    }
    const password = getRestorePassword(request);
    let payload;
    try {
      payload = await readBackupArchive(request.body, password);
    } catch (error) {
      throw new AppError("BACKUP_DECRYPT_FAILED", error instanceof Error ? error.message : "تعذر قراءة ملف النسخة", 422);
    }
    let report;
    try {
      report = await restoreBackupIntoCurrentDatabase(pool, payload, dryRun, dryRun ? undefined : async (client, restoreReport) => {
        await writeAudit(client, {
          actorUserId: request.user!.userId,
          actorEmployeeId: request.user!.employeeId,
          action: "restore",
          module: "system",
          entityType: "system_backup",
          metadata: { added: restoreReport.added, exactDuplicates: restoreReport.exactDuplicates, conflicts: restoreReport.conflicts.length },
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null
        });
      });
    } catch (error) {
      request.log.error({ err: error }, "System backup restore validation failed");
      throw new AppError("BACKUP_RESTORE_FAILED", error instanceof Error ? error.message : "تعذر استرداد النسخة", 422);
    }
    return reply.header("cache-control", "no-store, private").send({
      mode: dryRun ? "preview" : "restore",
      ...report
    });
  };

  app.post("/api/system-backups/restore/preview", {
    bodyLimit: MAX_ARCHIVE_BYTES + 4096,
    preHandler: [authenticateRequest, requirePermission("system.backup.restore")]
  }, restoreHandler(true));

  app.post("/api/system-backups/restore", {
    bodyLimit: MAX_ARCHIVE_BYTES + 4096,
    preHandler: [authenticateRequest, requirePermission("system.backup.restore")]
  }, restoreHandler(false));
}
