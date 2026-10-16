import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { hashPassword } from "../auth/auth.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const phoneSchema = z.string().trim().min(10).max(30).regex(/^[+()\d\s.-]+$/).refine(
  value => value.replace(/\D/g, "").length >= 10,
  "رقم الموبايل لازم يحتوي على 10 أرقام على الأقل"
);

const publicRequestSchema = z.object({
  fullName: z.string().trim().min(3).max(160),
  username: z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  phone: phoneSchema,
  password: z.string().min(12).max(200),
  confirmPassword: z.string().min(12).max(200)
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
  app.post("/api/auth/register", async (request, reply) => {
    const parsed = publicRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "راجع الاسم واسم المستخدم ورقم الموبايل الإلزامي وكلمة المرور (12 حرفًا على الأقل)", 422);

    const { fullName, username, phone, password } = parsed.data;
    const normalizedPhone = phone.replace(/\D/g, "").slice(-10);
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

      const inserted = await client.query(
        `INSERT INTO registration_requests(full_name,username,phone,password_hash,request_ip,user_agent)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING id,full_name,username,phone,created_at`,
        [fullName, username, phone.trim(), hashPassword(password), request.ip, request.headers["user-agent"] ?? null]
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
      employeeId: z.string().uuid().nullable().optional()
    }).superRefine((data, ctx) => {
      if (data.accountType === "employee" && !data.employeeId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["employeeId"], message: "اختار الموظف المرتبط بالحساب" });
      }
      if (data.accountType === "standalone" && data.employeeId) {
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

      const role = await client.query("SELECT id,code FROM roles WHERE code=$1 AND is_active=TRUE", [parsed.data.roleCode]);
      if (!role.rowCount) throw new AppError("ROLE_NOT_FOUND", "الدور غير موجود أو غير نشط", 422);
      if (role.rows[0].code === "manager") throw new AppError("MANAGER_ROLE_RESTRICTED", "لا يمكن منح دور مدير النظام من خلال طلب التسجيل؛ عيّنه يدويًا من إدارة الحسابات بعد المراجعة.", 403);

      if (parsed.data.accountType === "employee") {
        const employee = await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE", [parsed.data.employeeId]);
        if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 422);
        const linked = await client.query("SELECT 1 FROM users WHERE employee_id=$1 AND is_active=TRUE", [parsed.data.employeeId]);
        if (linked.rowCount) throw new AppError("EMPLOYEE_ACCOUNT_EXISTS", "الموظف ده مرتبط بالفعل بحساب دخول نشط. اختار موظفًا آخر أو راجع الحسابات.", 409);
      }

      const duplicate = await client.query("SELECT 1 FROM users WHERE lower(username)=lower($1)", [reg.username]);
      if (duplicate.rowCount) throw new AppError("USERNAME_EXISTS", "اسم المستخدم أصبح مستخدمًا بالفعل", 409);
      const normalizedPhone = reg.phone.replace(/\D/g, "").slice(-10);
      const duplicatePhone = await client.query(
        "SELECT 1 FROM users WHERE length(regexp_replace(COALESCE(phone,''),'[^0-9]','','g')) >= 10 AND RIGHT(regexp_replace(phone,'[^0-9]','','g'),10)=$1",
        [normalizedPhone]
      );
      if (duplicatePhone.rowCount) throw new AppError("PHONE_EXISTS", "رقم الموبايل أصبح مرتبطًا بحساب آخر", 409);

      const userResult = await client.query(
        `INSERT INTO users(username,full_name,phone,password_hash,employee_id,is_active)
         VALUES($1,$2,$3,$4,$5,TRUE) RETURNING id,code,username,phone,employee_id,is_active`,
        [reg.username, reg.full_name, reg.phone.trim(), reg.password_hash, parsed.data.accountType === "employee" ? parsed.data.employeeId : null]
      );
      const user = userResult.rows[0];
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
        afterData: { username: user.username, roleCode: role.rows[0].code, employeeId: user.employee_id, accountType: parsed.data.accountType, registrationRequestId: id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return { id: user.id, username: user.username, phone: user.phone, employeeId: user.employee_id, accountType: parsed.data.accountType, roleCode: role.rows[0].code };
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
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
    });
    return { data: { id, status: "rejected" } };
  });
}
