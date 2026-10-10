import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { hashPassword } from "../auth/auth.service.js";

const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(40).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  jobTitleId: z.string().uuid().nullable().optional(),
  hiredAt: z.string().date().nullable().optional(),
  roleCode: z.string().trim().min(2).max(60).default("worker")
});

export async function employeeRoutes(app: FastifyInstance) {
  app.get("/api/employees", { preHandler: [authenticateRequest, requirePermission("employees.view")] }, async () => {
    const result = await pool.query(
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
      const role = await client.query("SELECT id FROM roles WHERE code=$1 AND is_active=TRUE", [parsed.data.roleCode]);
      if (!role.rowCount) throw new AppError("ROLE_NOT_FOUND", "دور المستخدم غير موجود أو غير نشط", 422);

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
        const role = await client.query("SELECT id FROM roles WHERE code=$1 AND is_active=TRUE", [p.roleCode]);
        if (!role.rowCount) throw new AppError("ROLE_NOT_FOUND", "دور المستخدم غير موجود أو غير نشط", 422);
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

  app.post("/api/employees/:id/activate",{preHandler:[authenticateRequest,requirePermission("employees.edit")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await withTransaction(async client=>{
      const before=await client.query("SELECT id,code,full_name,is_active FROM employees WHERE id=$1 FOR UPDATE",[id]);
      if(!before.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
      const user=await client.query("SELECT id FROM users WHERE employee_id=$1 FOR UPDATE",[id]);
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
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"deactivate",module:"employees",entityType:"employee",entityId:id,afterData:e.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return e.rows[0];
    });
    return {data:r};
  });

}
