import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { hashPassword } from "./auth.service.js";
import { authenticateRequest } from "./auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

async function assertManager(userId: string) {
  const r = await pool.query(`SELECT EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
    JOIN users u ON u.id=ur.user_id
    WHERE ur.user_id=$1 AND u.is_active=TRUE AND r.code='manager'
      AND r.is_system=TRUE AND r.is_active=TRUE
  ) AS allowed`, [userId]);
  if (!r.rows[0]?.allowed) throw new AppError("MANAGER_REQUIRED","إدارة طلبات إعادة تعيين كلمة المرور للمدير فقط",403);
}

export async function passwordResetRoutes(app: FastifyInstance) {
  app.post("/api/auth/password-reset-requests", async (request, reply) => {
    const parsed = z.object({
      login: z.string().trim().min(3).max(120),
      phone: z.string().trim().max(30).optional().default("")
    }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR","اكتب اسم المستخدم أو رقم الموبايل بشكل صحيح",422);
    const login = parsed.data.login;
    const digits = (parsed.data.phone || login).replace(/\D/g,"");
    const normalizedPhone = digits.length >= 10 ? digits.slice(-10) : "";
    await withTransaction(async client => {
      const found = await client.query(
        `SELECT u.id FROM users u LEFT JOIN employees e ON e.id=u.employee_id
         WHERE lower(u.username)=lower($1)
           OR (length(regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g'))>=10 AND RIGHT(regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g'),10)=$2)
           OR (length(regexp_replace(COALESCE(e.phone,''),'[^0-9]','','g'))>=10 AND RIGHT(regexp_replace(COALESCE(e.phone,''),'[^0-9]','','g'),10)=$2)
         ORDER BY u.is_active DESC LIMIT 1`,
        [login, normalizedPhone || "0000000000"]
      );
      const userId = found.rows[0]?.id ?? null;
      const req = await client.query(
        `INSERT INTO password_reset_requests(user_id,requested_login,requested_phone)
         VALUES($1,$2,$3) RETURNING id`,
        [userId, login, parsed.data.phone || (normalizedPhone ? login : null)]
      );
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         SELECT u.id,'PASSWORD_RESET_REQUEST','طلب إعادة تعيين كلمة مرور',
           $1,'password_reset_request',$2
         FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
         WHERE u.is_active=TRUE AND r.code='manager' AND r.is_system=TRUE AND r.is_active=TRUE`,
        [`يوجد طلب جديد لإعادة تعيين كلمة مرور ويحتاج مراجعة الإدارة.`, req.rows[0].id]
      );
    });
    return reply.code(202).send({data:{submitted:true},message:"لو بيانات الحساب مطابقة، تم إرسال طلب إعادة تعيين كلمة المرور للإدارة. تابع مع المدير بعد المراجعة."});
  });

  app.get("/api/password-reset-requests", {preHandler:[authenticateRequest,requirePermission("users.create")]}, async request => {
    await assertManager(request.user!.userId);
    const r = await pool.query(
      `SELECT pr.id,pr.requested_login,pr.requested_phone,pr.status,pr.created_at,
              u.username,u.full_name,u.code AS user_code,e.code AS employee_code,e.full_name AS employee_name
       FROM password_reset_requests pr LEFT JOIN users u ON u.id=pr.user_id
       LEFT JOIN employees e ON e.id=u.employee_id
       WHERE pr.status='pending' ORDER BY pr.created_at ASC`
    );
    return {data:r.rows};
  });

  app.post("/api/password-reset-requests/:id/approve", {preHandler:[authenticateRequest,requirePermission("users.create")]}, async (request, reply) => {
    await assertManager(request.user!.userId);
    const id=(request.params as {id:string}).id;
    const parsed=z.object({temporaryPassword:z.string().min(12).max(200)}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","كلمة المرور المؤقتة لازم تكون 12 حرفًا على الأقل",422);
    await withTransaction(async client=>{
      const r=await client.query("SELECT * FROM password_reset_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!r.rowCount) throw new AppError("RESET_REQUEST_NOT_FOUND","طلب إعادة التعيين غير موجود",404);
      const item=r.rows[0];
      if(item.status!=="pending") throw new AppError("RESET_REQUEST_REVIEWED","تمت مراجعة الطلب بالفعل",409);
      if(!item.user_id) {
        throw new AppError(
          "RESET_ACCOUNT_NOT_FOUND",
          "لم يتم العثور على حساب مطابق لبيانات الطلب. ارفض الطلب أو تحقق من اسم المستخدم ورقم الموبايل قبل الموافقة.",
          422
        );
      }
      await client.query("UPDATE users SET password_hash=$1,must_change_password=TRUE,updated_at=now() WHERE id=$2",[hashPassword(parsed.data.temporaryPassword),item.user_id]);
      await client.query("UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[item.user_id]);
      await client.query("UPDATE password_reset_requests SET status='approved',reviewed_by=$1,reviewed_at=now(),updated_at=now() WHERE id=$2",[request.user!.userId,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"approve_password_reset",module:"iam",entityType:"user",entityId:item.user_id,metadata:{requestId:id},ipAddress:request.ip,userAgent:request.headers["user-agent"] ?? null});
    });
    return reply.code(200).send({data:{id,status:"approved"},message:"تم تعيين كلمة المرور المؤقتة. سلّمها لصاحب الحساب بشكل آمن، وسيُطلب منه تغييرها بعد الدخول."});
  });

  app.post("/api/password-reset-requests/:id/reject", {preHandler:[authenticateRequest,requirePermission("users.create")]}, async request => {
    await assertManager(request.user!.userId);
    const id=(request.params as {id:string}).id;
    await withTransaction(async client=>{
      const r=await client.query("SELECT id,status FROM password_reset_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!r.rowCount) throw new AppError("RESET_REQUEST_NOT_FOUND","طلب إعادة التعيين غير موجود",404);
      if(r.rows[0].status!=="pending") throw new AppError("RESET_REQUEST_REVIEWED","تمت مراجعة الطلب بالفعل",409);
      await client.query("UPDATE password_reset_requests SET status='rejected',reviewed_by=$1,reviewed_at=now(),updated_at=now() WHERE id=$2",[request.user!.userId,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reject_password_reset",module:"iam",entityType:"password_reset_request",entityId:id,ipAddress:request.ip,userAgent:request.headers["user-agent"] ?? null});
    });
    return {data:{id,status:"rejected"}};
  });
}
