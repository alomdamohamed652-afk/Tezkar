import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const codeSchema = z.string().trim().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/);
const departmentSchema = z.object({ code: codeSchema, name: z.string().trim().min(2).max(120) });
const jobTitleSchema = z.object({ code: codeSchema, name: z.string().trim().min(2).max(120), departmentId: z.string().uuid().nullable().optional() });

export async function masterDataRoutes(app: FastifyInstance) {
  app.get("/api/departments", { preHandler: [authenticateRequest, requirePermission("departments.view")] }, async () => {
    const result = await pool.query("SELECT d.id,d.code,d.name,d.is_active,COUNT(e.id)::int AS employee_count FROM departments d LEFT JOIN employees e ON e.department_id=d.id AND e.is_active=TRUE GROUP BY d.id ORDER BY d.code");
    return { data: result.rows };
  });

  app.post("/api/departments", { preHandler: [authenticateRequest, requirePermission("departments.create")] }, async (request, reply) => {
    const parsed = departmentSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات القسم غير صحيحة",422);
    const row = await withTransaction(async client => {
      try {
        const result = await client.query("INSERT INTO departments(code,name) VALUES($1,$2) RETURNING id,code,name,is_active,created_at",[parsed.data.code,parsed.data.name]);
        const created = result.rows[0];
        await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"master_data",entityType:"department",entityId:created.id,afterData:created,ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
        return created;
      } catch (error) { if ((error as {code?:string}).code==="23505") throw new AppError("DUPLICATE_CODE","كود القسم مستخدم بالفعل",409); throw error; }
    });
    return reply.code(201).send({data:row});
  });

  app.get("/api/job-titles", { preHandler: [authenticateRequest, requirePermission("job_titles.view")] }, async () => {
    const result = await pool.query("SELECT j.id,j.code,j.name,j.department_id,d.code AS department_code,d.name AS department_name,j.is_active FROM job_titles j LEFT JOIN departments d ON d.id=j.department_id ORDER BY j.code");
    return {data:result.rows};
  });

  app.post("/api/job-titles", { preHandler: [authenticateRequest, requirePermission("job_titles.create")] }, async (request, reply) => {
    const parsed=jobTitleSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات الوظيفة غير صحيحة",422);
    if(parsed.data.departmentId){ const check=await pool.query("SELECT 1 FROM departments WHERE id=$1 AND is_active=TRUE",[parsed.data.departmentId]); if(!check.rowCount) throw new AppError("DEPARTMENT_NOT_FOUND","القسم غير موجود أو غير نشط",422); }
    const row=await withTransaction(async client=>{
      try{
        const result=await client.query("INSERT INTO job_titles(code,name,department_id) VALUES($1,$2,$3) RETURNING id,code,name,department_id,is_active,created_at",[parsed.data.code,parsed.data.name,parsed.data.departmentId??null]);
        const created=result.rows[0];
        await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"master_data",entityType:"job_title",entityId:created.id,afterData:created,ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
        return created;
      }catch(error){ if((error as {code?:string}).code==="23505") throw new AppError("DUPLICATE_CODE","كود الوظيفة مستخدم بالفعل",409); throw error; }
    });
    return reply.code(201).send({data:row});
  });
}