import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { resetTrialData } from "../../db/reset-trial-data.service.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";

const enabled = () => process.env.TEZKAR_ENABLE_ONE_TIME_RESET === "true";

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

  app.post("/api/system/reset/execute", { preHandler: [authenticateRequest] }, async request => {
    await assertSystemManager(request.user!.userId);
    if (!enabled()) {
      throw new AppError("RESET_DISABLED", "ميزة المسح المؤقت غير مفعلة حاليًا", 403);
    }
    const parsed = z.object({ confirmation: z.literal("امسح كل بيانات النظام") }).safeParse(request.body);
    if (!parsed.success) {
      throw new AppError("RESET_CONFIRMATION_REQUIRED", "اكتب عبارة التأكيد كما هي قبل تنفيذ المسح", 422);
    }

    const report = await resetTrialData(request.user!.userId);
    return { data: { deletedRows: report.deletedRows, preservedTables: report.preservedTables } };
  });
}
