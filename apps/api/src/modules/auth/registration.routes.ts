import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { hashPassword } from "../auth/auth.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const publicRequestSchema = z.object({
  fullName: z.string().trim().min(3).max(160),
  username: z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  phone: z.string().trim().max(30).optional().default(""),
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
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "راجع الاسم واسم المستخدم ورقم الموبايل وكلمة المرور (12 حرفًا على الأقل)", 422);

    const { fullName, username, phone, password } = parsed.data;
    const result = await withTransaction(async (client) => {
      const existingUser = await client.query("SELECT 1 FROM users WHERE lower(username)=lower($1)", [username]);
      if (existingUser.rowCount) throw new AppError("USERNAME_EXISTS", "اسم المستخدم مستخدم بالفعل", 409);
      const existingRequest = await client.query(
        "SELECT 1 FROM registration_requests WHERE lower(username)=lower($1) AND status='pending'",
        [username]
      );
      if (existingRequest.rowCount) throw new AppError("REGISTRATION_PENDING", "يوجد طلب تسجيل معلّق باسم المستخدم ده بالفعل", 409);

      const inserted = await client.query(
        `INSERT INTO registration_requests(full_name,username,phone,password_hash,request_ip,user_agent)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING id,full_name,username,created_at`,
        [fullName, username, phone || null, hashPassword(password), request.ip, request.headers["user-agent"] ?? null]
      );
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         SELECT u.id,'REGISTRATION_REQUEST','طلب تسجيل حساب جديد',
           $1,'registration_request',$2
         FROM users u
         JOIN user_roles ur ON ur.user_id=u.id
         JOIN roles r ON r.id=ur.role_id
         WHERE u.is_active=TRUE AND r.code='manager' AND r.is_system=TRUE AND r.is_active=TRUE`,
        [`طلب حساب جديد من ${fullName} (اسم المستخدم: ${username}). راجع الطلبات لاختيار الدور وتفعيل الحساب.`, inserted.rows[0].id]
      );
      return inserted.rows[0];
    });
    return reply.code(201).send({
      data: { id: result.id, status: "pending" },
      message: "تم إرسال طلبك للإدارة. تقدر تسجل الدخول بعد موافقة المدير وتفعيل الحساب."
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
      employeeId: z.string().uuid().nullable().optional()
    }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اختار الدور المطلوب بشكل صحيح", 422);

    const created = await withTransaction(async (client) => {
      const requestResult = await client.query(
        "SELECT * FROM registration_requests WHERE id=$1 FOR UPDATE", [id]
      );
      if (!requestResult.rowCount) throw new AppError("REGISTRATION_NOT_FOUND", "طلب التسجيل غير موجود", 404);
      const reg = requestResult.rows[0];
      if (reg.status !== "pending") throw new AppError("REGISTRATION_ALREADY_REVIEWED", "تمت مراجعة الطلب ده بالفعل", 409);

      const role = await client.query(
        "SELECT id,code FROM roles WHERE code=$1 AND is_active=TRUE", [parsed.data.roleCode]
      );
      if (!role.rowCount) throw new AppError("ROLE_NOT_FOUND", "الدور غير موجود أو غير نشط", 422);
      if (parsed.data.employeeId) {
        const employee = await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE", [parsed.data.employeeId]);
        if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 422);
      }
      const duplicate = await client.query("SELECT 1 FROM users WHERE lower(username)=lower($1)", [reg.username]);
      if (duplicate.rowCount) throw new AppError("USERNAME_EXISTS", "اسم المستخدم أصبح مستخدمًا بالفعل", 409);

      const userResult = await client.query(
        `INSERT INTO users(username,password_hash,employee_id,is_active)
         VALUES($1,$2,$3,TRUE) RETURNING id,code,username,employee_id,is_active`,
        [reg.username, reg.password_hash, parsed.data.employeeId ?? null]
      );
      const user = userResult.rows[0];
      await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [user.id, role.rows[0].id]);
      await client.query(
        `UPDATE registration_requests SET status='approved',reviewed_by=$1,reviewed_at=now(),
          created_user_id=$2,updated_at=now() WHERE id=$3`,
        [request.user!.userId, user.id, id]
      );
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         VALUES($1,'REGISTRATION_APPROVED','تم تفعيل حسابك',
           'وافق مدير النظام على طلب التسجيل. تقدر تسجل الدخول باستخدام اسم المستخدم وكلمة المرور اللي أنشأتها.',
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
        afterData: { username: user.username, roleCode: role.rows[0].code, registrationRequestId: id },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return { id: user.id, username: user.username, roleCode: role.rows[0].code };
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
        "UPDATE registration_requests SET status='rejected',reviewed_by=$1,reviewed_at=now(),rejection_reason=$2,updated_at=now() WHERE id=$3",
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
