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
              e.is_active, e.hired_at
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN job_titles j ON j.id = e.job_title_id
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
  app.delete("/api/employees/:id",{preHandler:[authenticateRequest,requirePermission("employees.delete")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await withTransaction(async client=>{
      const e=await client.query("UPDATE employees SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,full_name,is_active",[id]);
      if(!e.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود",404);
      await client.query("UPDATE users SET is_active=FALSE,updated_at=now() WHERE employee_id=$1",[id]);
      return e.rows[0];
    });
    return {data:r};
  });

}
