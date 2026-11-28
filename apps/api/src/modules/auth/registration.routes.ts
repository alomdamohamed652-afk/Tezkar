import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { hashPassword } from "../auth/auth.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { randomInt } from "node:crypto";
import { isIP } from "node:net";
import {
  assertOtpRateAllowed,
  hashCode,
  safeEqualText,
  sendOtpEmail
} from "./email-otp.service.js";

const SIGNUP_OTP_MAX_ATTEMPTS = 5;

// Same normalization as the email-OTP fix (#380): never write an empty or
// invalid IP string to inet columns.
function getClientIp(ip: string | undefined): string | null {
  const value = ip?.trim() ?? "";
  return value && isIP(value) ? value : null;
}
const GENERIC_CODE_ERROR = "الكود غير صحيح أو منتهي الصلاحية. اطلب كودًا جديدًا وحاول مرة أخرى.";
const signupEmailSchema = z.string().trim().email().max(320);

async function verifySignupEmailCode(client: import("pg").PoolClient, email: string, code: string): Promise<boolean> {
  const r = await client.query(
    `SELECT id, code_hash, attempts FROM signup_email_otps
     WHERE lower(email)=lower($1) AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [email]
  );
  const row = r.rows[0];
  if (!row) return false;
  if (row.attempts >= SIGNUP_OTP_MAX_ATTEMPTS) {
    await client.query("UPDATE signup_email_otps SET consumed_at=now() WHERE id=$1", [row.id]);
    return false;
  }
  const expected = hashCode(email.toLowerCase(), "EMAIL_VERIFY", code);
  if (!safeEqualText(expected, row.code_hash)) {
    const attempts = row.attempts + 1;
    await client.query(
      "UPDATE signup_email_otps SET attempts=$1, consumed_at=CASE WHEN $1 >= $2 THEN now() ELSE NULL END WHERE id=$3",
      [attempts, SIGNUP_OTP_MAX_ATTEMPTS, row.id]
    );
    return false;
  }
  await client.query("UPDATE signup_email_otps SET consumed_at=now() WHERE id=$1", [row.id]);
  return true;
}

const phoneSchema = z.string().trim().min(10).max(30).regex(/^[+()\d\s.-]+$/).refine(
  value => value.replace(/\D/g, "").length >= 10,
  "رقم الموبايل لازم يحتوي على 10 أرقام على الأقل"
);

const publicRequestSchema = z.object({
  fullName: z.string().trim().min(3).max(160),
  username: z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  phone: phoneSchema,
  password: z.string().min(12).max(200),
  confirmPassword: z.string().min(12).max(200),
  email: signupEmailSchema.optional(),
  emailCode: z.string().trim().min(4).max(10).optional()
}).refine((data) => data.password === data.confirmPassword, {
  message: "كلمتا المرور غير متطابقتين",
  path: ["confirmPassword"]
});

async function assertManager(userId: string) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON r.id=ur.role_id
      JOIN users u ON u.id=ur.user_id
      WHERE ur.user_id=$1 AND u.is_active=TRUE
        AND r.code='manager' AND r.is_system=TRUE AND r.is_active=TRUE
    ) AS allowed`,
    [userId]
  );
  if (!result.rows[0]?.allowed) {
    throw new AppError("MANAGER_REQUIRED", "مراجعة طلبات التسجيل متاحة لمدير النظام فقط", 403);
  }
}

export async function registrationRoutes(app: FastifyInstance) {
  // Public: send an email verification code for a new signup (no account yet).
  app.post("/api/auth/register/email/request", async request => {
    const parsed = z.object({ email: signupEmailSchema }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اكتب البريد الإلكتروني بشكل صحيح", 422);
    const email = parsed.data.email;
    await assertOtpRateAllowed("register-email", email, 3, 60, 60, "طلبات كثيرة. حاول مرة أخرى بعد ساعة.");
    const taken = await pool.query("SELECT 1 FROM users WHERE lower(email)=lower($1) LIMIT 1", [email]);
    if (taken.rowCount) throw new AppError("EMAIL_TAKEN", "هذا البريد مسجل على حساب آخر", 409);
    const pending = await pool.query(
      "SELECT 1 FROM registration_requests WHERE status='pending' AND email IS NOT NULL AND lower(email)=lower($1) LIMIT 1",
      [email]
    );
    if (pending.rowCount) throw new AppError("REGISTRATION_EMAIL_PENDING", "يوجد طلب تسجيل معلّق بهذا البريد بالفعل", 409);
    const code = await withTransaction(async client => {
      await client.query("UPDATE signup_email_otps SET consumed_at=now() WHERE lower(email)=lower($1) AND consumed_at IS NULL", [email]);
      const newCode = randomInt(0, 1000000).toString().padStart(6, "0");
      await client.query(
        `INSERT INTO signup_email_otps (email, code_hash, expires_at, created_ip, created_user_agent)
         VALUES ($1,$2, now() + interval '10 minutes', $3, $4)`,
        [email, hashCode(email.toLowerCase(), "EMAIL_VERIFY", newCode), getClientIp(request.ip), request.headers["user-agent"] ?? null]
      );
      return newCode;
    });
    const sent = await sendOtpEmail(email, code, "EMAIL_VERIFY");
    if (!sent.ok) {
      await withTransaction(client =>
        client.query("UPDATE signup_email_otps SET consumed_at=now() WHERE lower(email)=lower($1) AND consumed_at IS NULL", [email])
      );
      throw new AppError("EMAIL_UNAVAILABLE", "خدمة البريد غير متاحة حاليًا. حاول مرة أخرى لاحقًا.", 503);
    }
    return { data: { sent: true }, message: "تم إرسال كود التحقق إلى بريدك. الكود صالح لمدة 10 دقائق." };
  });

  app.post("/api/auth/register", async (request, reply) => {
    const parsed = publicRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "راجع الاسم واسم المستخدم ورقم الموبايل الإلزامي وكلمة المرور (12 حرفًا على الأقل)", 422);

    const { fullName, username, phone, password, email, emailCode } = parsed.data;
    const normalizedPhone = phone.replace(/\D/g, "").slice(-10);
    // When an email is supplied it must be verified by the code we sent; the
    // verified email is stored on the request and later on the new user.
    if (email && !emailCode) throw new AppError("EMAIL_CODE_REQUIRED", "اكتب كود التحقق الذي وصل بريدك الإلكتروني", 422);
    const result = await withTransaction(async (client) => {
      const existingUser = await client.query("SELECT 1 FROM users WHERE lower(username)=lower($1)", [username]);
      if (existingUser.rowCount) throw new AppError("USERNAME_EXISTS", "اسم المستخدم مستخدم بالفعل", 409);
      const phoneUser = await client.query(
        "SELECT 1 FROM users WHERE length(regexp_replace(COALESCE(phone,''),'[^0-9]','','g')) >= 10 AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),10)=$1",
        [normalizedPhone]
      );
      if (phoneUser.rowCount) throw new AppError("PHONE_EXISTS", "رقم الموبايل مرتبط بحساب مستخدم بالفعل", 409);
      const existingRequest = await client.query(
        "SELECT 1 FROM registration_requests WHERE lower(username)=lower($1) AND status='pending'",
        [username]
      );
      if (existingRequest.rowCount) throw new AppError("REGISTRATION_PENDING", "يوجد طلب تسجيل معلّق باسم المستخدم ده بالفعل", 409);
      const phoneRequest = await client.query(
        "SELECT 1 FROM registration_requests WHERE status='pending' AND phone IS NOT NULL AND length(regexp_replace(phone,'[^0-9]','','g')) >= 10 AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),10)=$1",
        [normalizedPhone]
      );
      if (phoneRequest.rowCount) throw new AppError("REGISTRATION_PHONE_PENDING", "رقم الموبايل ده موجود في طلب تسجيل معلّق بالفعل", 409);

      let verifiedEmail: string | null = null;
      if (email) {
        const emailUser = await client.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [email]);
        if (emailUser.rowCount) throw new AppError("EMAIL_TAKEN", "هذا البريد مسجل على حساب آخر", 409);
        const ok = await verifySignupEmailCode(client, email, emailCode!);
        if (!ok) throw new AppError("EMAIL_CODE_INVALID", GENERIC_CODE_ERROR, 422);
        verifiedEmail = email;
      }

      const inserted = await client.query(
        `INSERT INTO registration_requests(full_name,username,phone,email,password_hash,request_ip,user_agent)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,full_name,username,phone,created_at`,
        [fullName, username, phone.trim(), verifiedEmail, hashPassword(password), getClientIp(request.ip), request.headers["user-agent"] ?? null]
      );
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         SELECT u.id,'REGISTRATION_REQUEST','طلب تسجيل حساب جديد',
           $1,'registration_request',$2
         FROM users u
         JOIN user_roles ur ON ur.user_id=u.id
         JOIN roles r ON r.id=ur.role_id
         WHERE u.is_active=TRUE AND r.code='manager' AND r.is_system=TRUE AND r.is_active=TRUE`,
        [`طلب حساب جديد من ${fullName} (اسم المستخدم: ${username}). راجع الطلبات لاختيار الدور وربط الحساب بالموظف أو إنشائه كمستخدم مستقل.`, inserted.rows[0].id]
      );
      return inserted.rows[0];
    });
    return reply.code(201).send({
      data: { id: result.id, status: "pending" },
      message: "تم إرسال طلبك للإدارة. تقدر تسجل الدخول باسم المستخدم أو رقم الموبايل بعد موافقة المدير وتفعيل الحساب."
    });
  });

  app.get("/api/registration-requests", {
    preHandler: [authenticateRequest, requirePermission("users.create")]
  }, async (request) => {
    await assertManager(request.user!.userId);
    const result = await pool.query(
      `SELECT id,full_name,username,phone,status,created_at
       FROM registration_requests
       WHERE status='pending'
       ORDER BY created_at ASC`
    );
    return { data: result.rows };
  });

  app.post("/api/registration-requests/:id/approve", {
    preHandler: [authenticateRequest, requirePermission("users.create")]
  }, async (request, reply) => {
    await assertManager(request.user!.userId);
    const id = (request.params as { id: string }).id;
    const parsed = z.object({
      roleCode: z.string().trim().min(2).max(60),
      accountType: z.enum(["employee", "standalone"]),
      employeeId: z.string().uuid().nullable().optional(),
      createEmployee: z.boolean().optional().default(false)
    }).superRefine((data, ctx) => {
      if (data.accountType === "employee" && !data.employeeId && !data.createEmployee) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["employeeId"], message: "اختار موظفًا موجودًا أو أنشئ ملف موظف جديد" });
      }
      if (data.accountType === "employee" && data.employeeId && data.createEmployee) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["createEmployee"], message: "اختار الربط بموظف موجود أو إنشاء موظف جديد" });
      }
      if (data.accountType === "standalone" && (data.employeeId || data.createEmployee)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["employeeId"], message: "المستخدم المستقل لا يرتبط بموظف" });
      }
    }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اختار نوع الحساب والدور والموظف عند الحاجة بشكل صحيح", 422);

    const created = await withTransaction(async (client) => {
      const requestResult = await client.query("SELECT * FROM registration_requests WHERE id=$1 FOR UPDATE", [id]);
      if (!requestResult.rowCount) throw new AppError("REGISTRATION_NOT_FOUND", "طلب التسجيل غير موجود", 404);
      const reg = requestResult.rows[0];
      if (reg.status !== "pending") throw new AppError("REGISTRATION_ALREADY_REVIEWED", "تمت مراجعة الطلب ده بالفعل", 409);
      if (!reg.phone || reg.phone.replace(/\D/g, "").length < 10) {
        throw new AppError("PHONE_REQUIRED", "طلب التسجيل ده قديم ولا يحتوي على رقم موبايل صالح؛ ارفضه واطلب من صاحبه إعادة التسجيل", 422);
      }

      const role = await client.query(
        `SELECT r.id,r.code,r.is_system,
                EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                        WHERE rp.role_id=r.id AND p.code IN ('rbac.manage','users.manage_roles')) AS manages_rbac
           FROM roles r WHERE r.code=$1 AND r.is_active=TRUE`,
        [parsed.data.roleCode]
      );
      if (!role.rowCount) throw new AppError("ROLE_NOT_FOUND", "الدور غير موجود أو غير نشط", 422);
      if (String(role.rows[0].code).toLowerCase() !== "worker" || role.rows[0].manages_rbac)
        throw new AppError("PRIVILEGED_ROLE_RESTRICTED", "لا يمكن منح دور إداري أو تشغيلي مميز من خلال طلب التسجيل؛ عيّنه مدير النظام يدويًا بعد المراجعة.", 403);

      let linkedUserId: string | null = null;
      let employeeId = parsed.data.employeeId ?? null;
      if (parsed.data.accountType === "employee" && parsed.data.createEmployee) {
        const createdEmployee = await client.query(
          "INSERT INTO employees(full_name,phone) VALUES($1,$2) RETURNING id,code",
          [reg.full_name, reg.phone.trim()]
        );
        employeeId = createdEmployee.rows[0].id;
      }
      if (parsed.data.accountType === "employee") {
        const employee = await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE", [employeeId]);
        if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 422);
        const linked = await client.query("SELECT id FROM users WHERE employee_id=$1 ORDER BY is_active DESC,created_at ASC LIMIT 1 FOR UPDATE", [employeeId]);
        linkedUserId = linked.rows[0]?.id ?? null;
      }

      const duplicate = await client.query(
        "SELECT 1 FROM users WHERE lower(username)=lower($1) AND ($2::uuid IS NULL OR id<>$2)",
        [reg.username, linkedUserId]
      );
      if (duplicate.rowCount) throw new AppError("USERNAME_EXISTS", "اسم المستخدم أصبح مستخدمًا بالفعل", 409);
      const normalizedPhone = reg.phone.replace(/\D/g, "").slice(-10);
      const duplicatePhone = await client.query(
        "SELECT 1 FROM users WHERE length(regexp_replace(COALESCE(phone,''),'[^0-9]','','g')) >= 10 AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),10)=$1 AND ($2::uuid IS NULL OR id<>$2)",
        [normalizedPhone, linkedUserId]
      );
      if (duplicatePhone.rowCount) throw new AppError("PHONE_EXISTS", "رقم الموبايل أصبح مرتبطًا بحساب آخر", 409);
      if (reg.email) {
        const duplicateEmail = await client.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [reg.email]);
        if (duplicateEmail.rowCount) throw new AppError("EMAIL_TAKEN", "البريد الإلكتروني في طلب التسجيل أصبح مسجلًا على حساب آخر", 409);
      }

      let user;
      if (linkedUserId) {
        throw new AppError(
          "EMPLOYEE_ACCOUNT_EXISTS",
          "الموظف ده مرتبط بحساب دخول بالفعل. لا يمكن استبدال كلمة مروره بطلب تسجيل جديد؛ استخدم طلب إعادة تعيين كلمة المرور أو راجع الحساب الحالي.",
          409
        );
      } else {
        const userResult = await client.query(
          `INSERT INTO users(username,full_name,phone,email,email_verified_at,password_hash,employee_id,is_active)
           VALUES($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id,code,username,phone,employee_id,is_active`,
          [reg.username, reg.full_name, reg.phone.trim(), reg.email ?? null, reg.email ? new Date() : null, reg.password_hash, parsed.data.accountType === "employee" ? employeeId : null]
        );
        user = userResult.rows[0];
      }
      await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [user.id, role.rows[0].id]);
      await client.query(
        `UPDATE registration_requests SET status='approved',reviewed_by=$1,reviewed_at=now(),
          created_user_id=$2,password_hash='!consumed!',updated_at=now() WHERE id=$3`,
        [request.user!.userId, user.id, id]
      );
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         VALUES($1,'REGISTRATION_APPROVED','تم تفعيل حسابك',
           'وافق مدير النظام على طلب التسجيل. تقدر تسجل الدخول باسم المستخدم أو رقم الموبايل المسجل وكلمة المرور التي أنشأتها.',
           'user',$1)`,
        [user.id]
      );
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "approve_registration",
        module: "iam",
        entityType: "user",
        entityId: user.id,
        afterData: { username: user.username, roleCode: role.rows[0].code, employeeId: user.employee_id, createdEmployee: parsed.data.accountType === "employee" && parsed.data.createEmployee, accountType: parsed.data.accountType, registrationRequestId: id },
        ipAddress: getClientIp(request.ip),
        userAgent: request.headers["user-agent"] ?? null
      });
      return { id: user.id, username: user.username, phone: user.phone, employeeId: user.employee_id, createdEmployee: parsed.data.accountType === "employee" && parsed.data.createEmployee, accountType: parsed.data.accountType, roleCode: role.rows[0].code };
    });
    return reply.code(201).send({ data: created });
  });

  app.post("/api/registration-requests/:id/reject", {
    preHandler: [authenticateRequest, requirePermission("users.create")]
  }, async (request) => {
    await assertManager(request.user!.userId);
    const id = (request.params as { id: string }).id;
    const parsed = z.object({ reason: z.string().trim().max(500).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "سبب الرفض غير صحيح", 422);

    await withTransaction(async (client) => {
      const found = await client.query("SELECT id,status,username FROM registration_requests WHERE id=$1 FOR UPDATE", [id]);
      if (!found.rowCount) throw new AppError("REGISTRATION_NOT_FOUND", "طلب التسجيل غير موجود", 404);
      if (found.rows[0].status !== "pending") throw new AppError("REGISTRATION_ALREADY_REVIEWED", "تمت مراجعة الطلب ده بالفعل", 409);
      await client.query(
        "UPDATE registration_requests SET status='rejected',reviewed_by=$1,reviewed_at=now(),rejection_reason=$2,password_hash='!rejected!',updated_at=now() WHERE id=$3",
        [request.user!.userId, parsed.data.reason || null, id]
      );
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "reject_registration",
        module: "iam",
        entityType: "registration_request",
        entityId: id,
        metadata: { username: found.rows[0].username, reason: parsed.data.reason || null },
        ipAddress: getClientIp(request.ip),
        userAgent: request.headers["user-agent"] ?? null
      });
    });
    return { data: { id, status: "rejected" } };
  });
}
