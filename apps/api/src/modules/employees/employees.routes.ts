import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(40).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  jobTitleId: z.string().uuid().nullable().optional(),
  hiredAt: z.string().date().nullable().optional()
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
      await writeAudit(client, {
        actorUserId: null,
        actorEmployeeId: null,
        action: "create",
        module: "employees",
        entityType: "employee",
        entityId: row.id,
        afterData: row
      });
      return row;
    });

    return reply.code(201).send({ data: employee });
  });
}
