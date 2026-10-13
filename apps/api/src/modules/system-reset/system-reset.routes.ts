import type { FastifyInstance } from "fastify";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { previewTrialDataReset, resetTrialData } from "../../db/reset-trial-data.service.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";

const enabled = () => process.env.TEZKAR_ENABLE_ONE_TIME_RESET === "true";
const previewFingerprint = (report: { deletedRows: Record<string, number>; preservedTables: string[] }) =>
  createHash("sha256").update(JSON.stringify({ deletedRows: report.deletedRows, preservedTables: report.preservedTables })).digest("hex");
const makePreviewToken = (userId: string, fingerprint: string, issuedAt: number) => {
  const payload = `${userId}.${issuedAt}.${fingerprint}`;
  const signature = createHmac("sha256", process.env.SESSION_SECRET ?? "").update(payload).digest("base64url");
  return `${issuedAt}.${fingerprint}.${signature}`;
};
const verifyPreviewToken = (token: string, userId: string, fingerprint: string) => {
  const [issuedAtRaw, tokenFingerprint, signature] = token.split(".");
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt) || !tokenFingerprint || !signature ||
      tokenFingerprint !== fingerprint || Date.now() - issuedAt > 10 * 60 * 1000 || issuedAt > Date.now() + 30_000) return false;
  const payload = `${userId}.${issuedAt}.${tokenFingerprint}`;
  const expected = createHmac("sha256", process.env.SESSION_SECRET ?? "").update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};

async function resetUsed() {
  const result = await pool.query("SELECT EXISTS (SELECT 1 FROM public.system_reset_events WHERE operation_key = 'trial-data-reset') AS used");
  return Boolean(result.rows[0]?.used);
}

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
    throw new AppError("RESET_ADMIN_REQUIRED", "مسح بيانات النظام متاح لمدير النظام فقط", 403);
  }
}

export async function systemResetRoutes(app: FastifyInstance) {
  app.get("/api/system/reset/status", { preHandler: [authenticateRequest] }, async request => {
    await assertSystemManager(request.user!.userId);
    const used = await resetUsed();
    return { data: { enabled: enabled() && !used, configured: enabled(), used } };
  });

  app.get("/api/system/reset/preview", { preHandler: [authenticateRequest] }, async request => {
    await assertSystemManager(request.user!.userId);
    if (!enabled()) {
      throw new AppError("RESET_DISABLED", "ميزة المسح المؤقت غير مفعلة حاليًا", 403);
    }
    if (await resetUsed()) {
      throw new AppError("RESET_ALREADY_USED", "تم تنفيذ مسح بيانات التجربة بالفعل", 409);
    }
    const report = await previewTrialDataReset(request.user!.userId);
    const issuedAt = Date.now();
    return { data: { ...report, previewToken: makePreviewToken(request.user!.userId, previewFingerprint(report), issuedAt) } };
  });

  app.post("/api/system/reset/execute", { preHandler: [authenticateRequest] }, async request => {
    await assertSystemManager(request.user!.userId);
    if (!enabled()) {
      throw new AppError("RESET_DISABLED", "ميزة المسح المؤقت غير مفعلة حاليًا", 403);
    }
    const parsed = z.object({
      confirmation: z.literal("امسح كل بيانات النظام"),
      previewToken: z.string().min(20).max(512)
    }).safeParse(request.body);
    if (!parsed.success) {
      throw new AppError("RESET_CONFIRMATION_REQUIRED", "نفّذ المعاينة أولًا واكتب عبارة التأكيد كما هي قبل المسح", 422);
    }
    const currentPreview = await previewTrialDataReset(request.user!.userId);
    if (!verifyPreviewToken(parsed.data.previewToken, request.user!.userId, previewFingerprint(currentPreview))) {
      throw new AppError("RESET_PREVIEW_EXPIRED", "انتهت صلاحية المعاينة أو تغيرت البيانات؛ أعد المعاينة قبل المسح", 409);
    }

    const report = await resetTrialData(request.user!.userId);
    return { data: { deletedRows: report.deletedRows, preservedTables: report.preservedTables } };
  });
}
