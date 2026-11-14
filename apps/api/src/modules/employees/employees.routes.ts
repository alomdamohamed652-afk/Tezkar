import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requireAnyPermission, requirePermission } from "../rbac/permission.guard.js";
import { hasPermission } from "../rbac/rbac.service.js";
import { hashPassword } from "../auth/auth.service.js";

const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(40).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  jobTitleId: z.string().uuid().nullable().optional(),
  hiredAt: z.string().date().nullable().optional(),
  roleCode: z.string().trim().min(2).max(60).default("worker")
});

async function assertCanAssignPrivilegedRole(
  client: import("pg").PoolClient,
  actorUserId: string,
  role: { code: string; is_system: boolean; manages_rbac: boolean }
) {
  const privileged=role.code.toLowerCase()!=="worker"||role.manages_rbac;
  if(!privileged)return;
  const admin=await client.query(
    `SELECT EXISTS(
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        WHERE ur.user_id=$1 AND r.code='manager' AND r.is_system=TRUE AND r.is_active=TRUE
     ) AS allowed`,
    [actorUserId]
  );
  if(!admin.rows[0]?.allowed)
    throw new AppError("RBAC_ADMIN_REQUIRED","تعيين دور إداري أو تشغيلي مميز متاح لمدير النظام فقط",403);
}

export async function employeeRoutes(app: FastifyInstance) {
  app.get("/api/employees", {
    preHandler: [authenticateRequest, requireAnyPermission(["employees.view", "all"], ["employees.lookup", "all"])]
  }, async (request) => {
    const client = await pool.connect();
    try {
      const canViewDirectory = await hasPermission(client, request.user!.userId, "employees.view", "all");
      if (!canViewDirectory) {
        const result = await client.query(
          "SELECT id,code,full_name,is_active FROM employees WHERE is_active=TRUE ORDER BY code"
        );
        return { data: result.rows };
      }
      const result = await client.query(
        `SELECT e.id, e.code, e.full_name, e.phone,
                d.code AS department_code, d.name AS department_name,
                j.code AS job_title_code, j.name AS job_title_name,
                r.code AS role_code,
                e.is_active, e.hired_at
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN job_titles j ON j.id = e.job_title_id
         LEFT JOIN users u ON u.employee_id = e.id
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         ORDER BY e.code`
      );
      return { data: result.rows };
    } finally {
      client.release();
    }
  });

  app.post("/api/employees", { preHandler: [authenticateRequest, requirePermission("employees.create")] }, async (request, reply) => {
    const parsed = createEmployeeSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات الموظف غير صحيحة", 422);

    const employee = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO employees (full_name, phone, department_id, job_title_id, hired_at)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, code, full_name, phone, department_id, job_title_id, hired_at, is_active`,
        [
          parsed.data.fullName, parsed.data.phone ?? null, parsed.data.departmentId ?? null,
          parsed.data.jobTitleId ?? null, parsed.data.hiredAt ?? null
        ]
      );
      const row = result.rows[0];
      const role = await client.query(
        `SELECT r.id,r.code,r.is_system,
                EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                        WHERE rp.role_id=r.id AND p.code IN ('rbac.manage','users.manage_roles')) AS manages_rbac
           FROM roles r WHERE r.code=$1 AND r.is_active=TRUE`,
        [parsed.data.roleCode]
      );
      if (!role.rowCount) throw new AppError("ROLE_NOT_FOUND", "دور المستخدم غير موجود أو غير نشط", 422);
      await assertCanAssignPrivilegedRole(client,request.user!.userId,role.rows[0]);

      const generatedPassword = "Tz" + crypto.randomBytes(9).toString("base64url");
      const generatedUsername = row.code.toLowerCase();

      const userResult = await client.query(
        "INSERT INTO users(username,password_hash,employee_id) VALUES($1,$2,$3) RETURNING id,code,username",
        [generatedUsername, hashPassword(generatedPassword), row.id]
      );
      const createdUser = userResult.rows[0];

      await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [createdUser.id, role.rows[0].id]);

      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "create",
        module: "employees",
        entityType: "employee",
        entityId: row.id,
        afterData: { ...row, userCode: createdUser.code, roleCode: parsed.data.roleCode },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return { employee: row, credentials: { username: generatedUsername, password: generatedPassword, roleCode: parsed.data.roleCode } };
    });

    return reply.code(201).send({ data: employee });
  });
  app.patch("/api/employees/:id", { preHandler: [authenticateRequest, requirePermission("employees.edit")] }, async (request) => {
    const id = (request.params as { id: string }).id;
    const parsed = z.object({
      fullName: z.string().trim().min(2).max(200).optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      departmentId: z.string().uuid().nullable().optional(),
      jobTitleId: z.string().uuid().nullable().optional(),
      hiredAt: z.string().date().nullable().optional(),
      roleCode: z.string().trim().min(2).max(60).optional()
    }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات تعديل الموظف غير صحيحة", 422);

    const updated = await withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM employees WHERE id=$1 FOR UPDATE", [id]);
      if (!before.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود", 404);

      const p = parsed.data;
      const sets:string[] = [];
      const params:unknown[] = [];
      const add = (sql:string, value:unknown) => { params.push(value); sets.push(sql.replace("$N", "$"+params.length)); };
      if (p.fullName !== undefined) add("full_name=$N", p.fullName);
      if (p.phone !== undefined) add("phone=$N", p.phone);
      if (p.departmentId !== undefined) add("department_id=$N", p.departmentId);
      if (p.jobTitleId !== undefined) add("job_title_id=$N", p.jobTitleId);
      if (p.hiredAt !== undefined) add("hired_at=$N", p.hiredAt);
      if (!sets.length && p.roleCode === undefined) return before.rows[0];

      let row = before.rows[0];
      if (sets.length) {
        params.push(id);
        const result = await client.query(
          "UPDATE employees SET "+sets.join(", ")+", updated_at=now() WHERE id=$"+params.length+" RETURNING *",
          params
        );
        row = result.rows[0];
      }

      if (p.roleCode !== undefined) {
        const role = await client.query(
          `SELECT r.id,r.code,r.is_system,
                  EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                          WHERE rp.role_id=r.id AND p.code IN ('rbac.manage','users.manage_roles')) AS manages_rbac
             FROM roles r WHERE r.code=$1 AND r.is_active=TRUE`,
          [p.roleCode]
        );
        if (!role.rowCount) throw new AppError("ROLE_NOT_FOUND", "دور المستخدم غير موجود أو غير نشط", 422);
        await assertCanAssignPrivilegedRole(client,request.user!.userId,role.rows[0]);
        const user = await client.query("SELECT id FROM users WHERE employee_id=$1 FOR UPDATE", [id]);
        if (!user.rowCount) throw new AppError("EMPLOYEE_ACCOUNT_NOT_FOUND", "لا يوجد حساب دخول مرتبط بالموظف", 409);
        await client.query("DELETE FROM user_roles WHERE user_id=$1", [user.rows[0].id]);
        await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [user.rows[0].id, role.rows[0].id]);
      }

      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "update",
        module: "employees",
        entityType: "employee",
        entityId: id,
        beforeData: before.rows[0],
        afterData: row,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return row;
    });

    return { data: updated };
  });

  app.post("/api/employees/:id/reset-password",{preHandler:[authenticateRequest,requirePermission("users.edit")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const result=await withTransaction(async client=>{
      const admin=await client.query(
        `SELECT EXISTS(
          SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
          WHERE ur.user_id=$1 AND r.code='manager' AND r.is_system=TRUE AND r.is_active=TRUE
        ) AS allowed`,
        [request.user!.userId]
      );
      if(!admin.rows[0]?.allowed)throw new AppError("RBAC_ADMIN_REQUIRED","إعادة تعيين كلمات المرور متاحة لمدير النظام فقط",403);
      const employee=await client.query("SELECT id,code,full_name,is_active FROM employees WHERE id=$1 FOR UPDATE",[id]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
      if(!employee.rows[0].is_active)throw new AppError("EMPLOYEE_INACTIVE","لا يمكن إعادة تعيين كلمة مرور موظف غير نشط",409);
      const user=await client.query("SELECT id,username,is_active,is_bootstrap FROM users WHERE employee_id=$1 FOR UPDATE",[id]);
      if(!user.rowCount)throw new AppError("EMPLOYEE_ACCOUNT_NOT_FOUND","لا يوجد حساب دخول مرتبط بالموظف",409);
      if(user.rows[0].is_bootstrap)throw new AppError("BOOTSTRAP_LOCKED","لا يمكن إعادة تعيين كلمة مرور حساب الإعداد الأساسي من هنا",409);
      if(!user.rows[0].is_active)throw new AppError("USER_INACTIVE","حساب الموظف غير نشط؛ فعّل الحساب أولًا",409);
      const temporaryPassword="Tz!"+crypto.randomBytes(15).toString("base64url");
      await client.query("UPDATE users SET password_hash=$1,must_change_password=TRUE,updated_at=now() WHERE id=$2",[hashPassword(temporaryPassword),user.rows[0].id]);
      await client.query("UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[user.rows[0].id]);
      await client.query("INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id) VALUES($1,'PASSWORD_RESET','تمت إعادة تعيين كلمة مرور حسابك','قام مدير النظام بإعادة تعيين كلمة المرور. استخدم كلمة المرور المؤقتة التي سلّمها لك المدير، ثم غيّرها من صفحة حسابي.','user',$2)",[user.rows[0].id,user.rows[0].id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reset_password",module:"employees",entityType:"employee",entityId:id,metadata:{employeeCode:employee.rows[0].code,targetUsername:user.rows[0].username,sessionsRevoked:true},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {username:user.rows[0].username,temporaryPassword};
    });
    return {data:result};
  });

  app.post("/api/employees/:id/activate",{preHandler:[authenticateRequest,requirePermission("employees.edit")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await withTransaction(async client=>{
      const before=await client.query("SELECT id,code,full_name,is_active FROM employees WHERE id=$1 FOR UPDATE",[id]);
      if(!before.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
      const user=await client.query(
        `SELECT u.id,u.is_active,r.code,r.is_system,
                EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                        WHERE rp.role_id=r.id AND p.code IN ('rbac.manage','users.manage_roles')) AS manages_rbac
           FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id
          WHERE u.employee_id=$1 ORDER BY u.id FOR UPDATE OF u`,
        [id]
      );
      for(const account of user.rows){
        if(!account.is_active)await client.query("UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[account.id]);
        if(account.code)await assertCanAssignPrivilegedRole(client,request.user!.userId,account);
      }
      if(!before.rows[0].is_active)await client.query("UPDATE user_sessions SET revoked_at=now() WHERE user_id IN (SELECT id FROM users WHERE employee_id=$1) AND revoked_at IS NULL",[id]);
      if(!user.rowCount)throw new AppError("EMPLOYEE_ACCOUNT_NOT_FOUND","لا يوجد حساب دخول مرتبط بالموظف؛ راجع بيانات الحساب قبل التفعيل",409);
      const employee=await client.query("UPDATE employees SET is_active=TRUE,updated_at=now() WHERE id=$1 RETURNING id,code,full_name,is_active",[id]);
      await client.query("UPDATE users SET is_active=TRUE,updated_at=now() WHERE employee_id=$1",[id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"activate",module:"employees",entityType:"employee",entityId:id,beforeData:before.rows[0],afterData:employee.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return employee.rows[0];
    });
    return {data:r};
  });

  app.delete("/api/employees/:id",{preHandler:[authenticateRequest,requirePermission("employees.delete")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await withTransaction(async client=>{
      const e=await client.query("UPDATE employees SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,full_name,is_active",[id]);
      if(!e.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
      await client.query("UPDATE users SET is_active=FALSE,updated_at=now() WHERE employee_id=$1",[id]);
       await client.query("UPDATE user_sessions SET revoked_at=now() WHERE user_id IN (SELECT id FROM users WHERE employee_id=$1) AND revoked_at IS NULL",[id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"deactivate",module:"employees",entityType:"employee",entityId:id,afterData:e.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return e.rows[0];
    });
    return {data:r};
  });

}
