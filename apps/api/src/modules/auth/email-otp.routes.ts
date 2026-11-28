import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { hashPassword } from "./auth.service.js";
import { authenticateRequest } from "./auth.middleware.js";
import { writeAudit } from "../audit/audit.service.js";
import {
  assertOtpRateAllowed,
  consumeActiveOtps,
  createOtp,
  fakeMask,
  maskEmail,
  normalizePhoneDigits,
  safeEqualText,
  sendOtpEmail,
  verifyOtp
} from "./email-otp.service.js";

type FoundUser = { id: string; email: string | null; email_verified_at: string | null };

// Exactly one active account must match the phone; zero or ambiguous matches
// are all treated as "no account" so the response never leaks anything.
async function findUserByPhone(phoneDigits: string): Promise<FoundUser | null> {
  if (!phoneDigits) return null;
  const r = await pool.query(
    `SELECT u.id, u.email, u.email_verified_at
       FROM users u LEFT JOIN employees e ON e.id=u.employee_id
      WHERE u.is_active=TRUE AND (
        (length(regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g'))>=10 AND RIGHT(regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g'),10)=$1)
        OR (length(regexp_replace(COALESCE(e.phone,''),'[^0-9]','','g'))>=10 AND RIGHT(regexp_replace(COALESCE(e.phone,''),'[^0-9]','','g'),10)=$1)
      )`,
    [phoneDigits]
  );
  return r.rowCount === 1 ? (r.rows[0] as FoundUser) : null;
}

const GENERIC_SENT_MESSAGE = "لو البيانات مطابقة لحسابك هيوصلك كود التحقق على بريدك خلال دقائق.";
const GENERIC_CODE_ERROR = "الكود غير صحيح أو منتهي الصلاحية. اطلب كودًا جديدًا وحاول مرة أخرى.";

function getClientIp(ip: string | undefined): string | null {
  const value = ip?.trim() ?? "";
  return value && isIP(value) ? value : null;
}

export async function emailOtpRoutes(app: FastifyInstance) {
  // Step 1 (public): phone -> masked email. Unknown phones get a stable fake
  // mask so account existence is never revealed.
  app.post("/api/auth/password-reset/email/lookup", async request => {
    const parsed = z.object({ phone: z.string().trim().min(6).max(30) }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اكتب رقم الموبايل بشكل صحيح", 422);
    const phoneDigits = normalizePhoneDigits(parsed.data.phone);
    const clientIp = getClientIp(request.ip);
    await assertOtpRateAllowed("lookup-phone", phoneDigits || parsed.data.phone, 3, 60, 60, "محاولات كثيرة على هذا الرقم. حاول مرة أخرى بعد ساعة.");
    if (clientIp) await assertOtpRateAllowed("lookup-ip", clientIp, 10, 15, 15, "محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.");
    const user = await findUserByPhone(phoneDigits);
    const maskedEmail = user?.email && user.email_verified_at
      ? maskEmail(user.email)
      : fakeMask(phoneDigits || parsed.data.phone);
    return { data: { maskedEmail } };
  });

  // Step 2 (public): phone + full email -> send OTP. Same response whether or
  // not anything matched.
  app.post("/api/auth/password-reset/email/request", async request => {
    const parsed = z.object({
      phone: z.string().trim().min(6).max(30),
      email: z.string().trim().email().max(320)
    }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اكتب رقم الموبايل والبريد الإلكتروني بشكل صحيح", 422);
    const phoneDigits = normalizePhoneDigits(parsed.data.phone);
    const clientIp = getClientIp(request.ip);
    await assertOtpRateAllowed("request-phone", phoneDigits || parsed.data.phone, 3, 60, 60, "طلبات كثيرة على هذا الرقم. حاول مرة أخرى بعد ساعة.");
    if (clientIp) await assertOtpRateAllowed("request-ip", clientIp, 5, 15, 15, "طلبات كثيرة. حاول مرة أخرى بعد 15 دقيقة.");
    const user = await findUserByPhone(phoneDigits);
    if (user?.email && user.email_verified_at && safeEqualText(user.email.trim().toLowerCase(), parsed.data.email.trim().toLowerCase())) {
      const code = await withTransaction(client =>
        createOtp(client, user.id, "PASSWORD_RESET", clientIp, request.headers["user-agent"] ?? null)
      );
      const sent = await sendOtpEmail(user.email, code, "PASSWORD_RESET");
      if (!sent.ok) {
        await withTransaction(client => consumeActiveOtps(client, user.id, "PASSWORD_RESET"));
      } else {
        await withTransaction(client =>
          writeAudit(client, { actorUserId: user.id, actorEmployeeId: null, action: "request_password_reset_email_otp", module: "auth", entityType: "user", entityId: user.id, ipAddress: clientIp, userAgent: request.headers["user-agent"] ?? null })
        );
      }
    }
    return { data: { sent: true }, message: GENERIC_SENT_MESSAGE };
  });

  // Step 3 (public): phone + code + new password -> reset. One generic error
  // for every failure shape.
  app.post("/api/auth/password-reset/email/confirm", async request => {
    const parsed = z.object({
      phone: z.string().trim().min(6).max(30),
      code: z.string().trim().regex(/^\d{6}$/),
      newPassword: z.string().min(12).max(200),
      confirmPassword: z.string().min(12).max(200)
    }).safeParse(request.body);
    if (!parsed.success || parsed.data.newPassword !== parsed.data.confirmPassword)
      throw new AppError("VALIDATION_ERROR", "كلمة المرور الجديدة لازم تكون 12 حرفًا على الأقل ومتطابقة مع التأكيد", 422);
    const clientIp = getClientIp(request.ip);
    if (clientIp) await assertOtpRateAllowed("confirm-ip", clientIp, 10, 15, 15, "محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.");
    const user = await findUserByPhone(normalizePhoneDigits(parsed.data.phone));
    if (!user) throw new AppError("OTP_INVALID", GENERIC_CODE_ERROR, 400);
    await withTransaction(async client => {
      const ok = await verifyOtp(client, user.id, "PASSWORD_RESET", parsed.data.code);
      if (!ok) throw new AppError("OTP_INVALID", GENERIC_CODE_ERROR, 400);
      await client.query("UPDATE users SET password_hash=$1, must_change_password=FALSE, updated_at=now() WHERE id=$2", [hashPassword(parsed.data.newPassword), user.id]);
      await client.query("UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [user.id]);
      await client.query("UPDATE password_reset_otps SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [user.id]);
      await writeAudit(client, { actorUserId: user.id, actorEmployeeId: null, action: "reset_password_email_otp", module: "auth", entityType: "user", entityId: user.id, ipAddress: getClientIp(request.ip), userAgent: request.headers["user-agent"] ?? null });
    });
    return { data: { reset: true }, message: "تم تغيير كلمة المرور. سجّل دخولك بكلمة المرور الجديدة." };
  });

  // Authenticated: start email verification (sends a code to the typed email).
  app.post("/api/me/email/request", { preHandler: [authenticateRequest] }, async request => {
    const parsed = z.object({ email: z.string().trim().email().max(320) }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اكتب البريد الإلكتروني بشكل صحيح", 422);
    const email = parsed.data.email;
    const userId = request.user!.userId;
    await assertOtpRateAllowed("me-email", userId, 3, 60, 60, "طلبات كثيرة. حاول مرة أخرى بعد ساعة.");
    const taken = await pool.query("SELECT 1 FROM users WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1", [email, userId]);
    if (taken.rowCount) throw new AppError("EMAIL_TAKEN", "هذا البريد مسجل على حساب آخر", 409);
    const code = await withTransaction(async client => {
      await client.query("UPDATE users SET email=$1, email_verified_at=NULL, updated_at=now() WHERE id=$2", [email, userId]);
      return createOtp(client, userId, "EMAIL_VERIFY", getClientIp(request.ip), request.headers["user-agent"] ?? null);
    });
    const sent = await sendOtpEmail(email, code, "EMAIL_VERIFY");
    if (!sent.ok) {
      await withTransaction(client => consumeActiveOtps(client, userId, "EMAIL_VERIFY"));
      throw new AppError("EMAIL_UNAVAILABLE", "خدمة البريد غير متاحة حاليًا. حاول مرة أخرى لاحقًا.", 503);
    }
    await withTransaction(client =>
      writeAudit(client, { actorUserId: userId, actorEmployeeId: request.user!.employeeId, action: "request_email_verify", module: "auth", entityType: "user", entityId: userId, ipAddress: getClientIp(request.ip), userAgent: request.headers["user-agent"] ?? null })
    );
    return { data: { sent: true }, message: "تم إرسال كود التأكيد إلى بريدك. الكود صالح لمدة 10 دقائق." };
  });

  // Authenticated: confirm the code -> email becomes verified and usable for reset.
  app.post("/api/me/email/confirm", { preHandler: [authenticateRequest] }, async request => {
    const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اكتب الكود المكوّن من 6 أرقام", 422);
    const userId = request.user!.userId;
    await assertOtpRateAllowed("me-email-confirm", userId, 10, 15, 15, "محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.");
    await withTransaction(async client => {
      const hasEmail = await client.query("SELECT email FROM users WHERE id=$1", [userId]);
      if (!hasEmail.rows[0]?.email) throw new AppError("EMAIL_MISSING", "أضف بريدك الإلكتروني أولًا", 422);
      const ok = await verifyOtp(client, userId, "EMAIL_VERIFY", parsed.data.code);
      if (!ok) throw new AppError("OTP_INVALID", GENERIC_CODE_ERROR, 400);
      await client.query("UPDATE users SET email_verified_at=now(), updated_at=now() WHERE id=$1", [userId]);
      await writeAudit(client, { actorUserId: userId, actorEmployeeId: request.user!.employeeId, action: "verify_account_email", module: "auth", entityType: "user", entityId: userId, ipAddress: getClientIp(request.ip), userAgent: request.headers["user-agent"] ?? null });
    });
    return { data: { verified: true }, message: "تم تأكيد بريدك الإلكتروني. يمكنك الآن استخدامه لاستعادة كلمة المرور." };
  });
}
