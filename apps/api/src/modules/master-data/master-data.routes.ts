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

  app.delete("/api/departments/:id",{preHandler:[authenticateRequest,requirePermission("departments.delete")]},async(req)=>{
    const id=(req.params as {id:string}).id;
    const used=await pool.query("SELECT COUNT(*)::int AS n FROM employees WHERE department_id=$1 AND is_active=TRUE",[id]);
    if(Number(used.rows[0].n)>0)throw new AppError("DEPARTMENT_IN_USE","لا يمكن تعطيل قسم عليه موظفون نشطون",409);
    const r=await pool.query("UPDATE departments SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,name,is_active",[id]);
    if(!r.rowCount)throw new AppError("DEPARTMENT_NOT_FOUND","القسم غير موجود",404);
    return {data:r.rows[0]};
  });

  app.delete("/api/job-titles/:id",{preHandler:[authenticateRequest,requirePermission("job_titles.delete")]},async(req)=>{
    const id=(req.params as {id:string}).id;
    const used=await pool.query("SELECT COUNT(*)::int AS n FROM employees WHERE job_title_id=$1 AND is_active=TRUE",[id]);
    if(Number(used.rows[0].n)>0)throw new AppError("JOB_TITLE_IN_USE","لا يمكن تعطيل وظيفة مرتبطة بموظفين نشطين",409);
    const r=await pool.query("UPDATE job_titles SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,name,is_active",[id]);
    if(!r.rowCount)throw new AppError("JOB_TITLE_NOT_FOUND","الوظيفة غير موجودة",404);
    return {data:r.rows[0]};
  });

  app.get("/api/product-categories",{preHandler:[authenticateRequest,requirePermission("products.view")]},async()=>{
    const result=await pool.query("SELECT id,code,name,category_type,is_active FROM product_categories ORDER BY code");
    return {data:result.rows};
  });

  app.post("/api/product-categories",{preHandler:[authenticateRequest,requirePermission("products.create")]},async(request,reply)=>{
    const parsed=z.object({
      name:z.string().trim().min(2).max(120),
      categoryType:z.enum(["PRODUCT","RAW_MATERIAL","PRODUCTION_SUPPLY","OPERATING_SUPPLY"]).default("PRODUCT")
    }).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات التصنيف غير صحيحة",422);
    const row=await withTransaction(async client=>{
      try{
        const result=await client.query(
          "INSERT INTO product_categories(name,category_type) VALUES($1,$2) RETURNING id,code,name,category_type,is_active",
          [parsed.data.name,parsed.data.categoryType]
        );
        await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"master_data",entityType:"product_category",entityId:result.rows[0].id,afterData:result.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
        return result.rows[0];
      }catch(error){
        if((error as {code?:string}).code==="23505")throw new AppError("DUPLICATE_CATEGORY","اسم/كود التصنيف مستخدم بالفعل",409);
        throw error;
      }
    });
    return reply.code(201).send({data:row});
  });

  app.delete("/api/product-categories/:id",{preHandler:[authenticateRequest,requirePermission("product_categories.delete")]},async(req)=>{
    const id=(req.params as {id:string}).id;
    const used=await pool.query("SELECT COUNT(*)::int AS n FROM products WHERE category_id=$1 AND is_active=TRUE",[id]);
    if(Number(used.rows[0].n)>0)throw new AppError("CATEGORY_IN_USE","لا يمكن تعطيل تصنيف عليه منتجات نشطة",409);
    const r=await pool.query("UPDATE product_categories SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,name,is_active",[id]);
    if(!r.rowCount)throw new AppError("CATEGORY_NOT_FOUND","التصنيف غير موجود",404);
    return {data:r.rows[0]};
  });

  app.delete("/api/products/:id",{preHandler:[authenticateRequest,requirePermission("products.delete")]},async(req)=>{
    const id=(req.params as {id:string}).id;
    const r=await pool.query("UPDATE products SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,name,is_active",[id]);
    if(!r.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود",404);
    return {data:r.rows[0]};
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