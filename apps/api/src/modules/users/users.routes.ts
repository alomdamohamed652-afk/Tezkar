import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { hashPassword } from "../auth/auth.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const createUserSchema=z.object({
 username:z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/),
 password:z.string().min(12).max(200),
 employeeId:z.string().uuid().nullable().optional(),
 roleCode:z.string().trim().min(2).max(60)
});
const editUserSchema=z.object({
 employeeId:z.string().uuid().nullable().optional(),
 roleCode:z.string().trim().min(2).max(60).optional(),
 isActive:z.boolean().optional()
});

export async function userRoutes(app: FastifyInstance){
 app.get("/api/users",{preHandler:[authenticateRequest,requirePermission("users.view")]},async()=>{
  const result=await pool.query("SELECT u.id,u.code,u.username,u.employee_id,e.code AS employee_code,e.full_name, u.is_active,u.is_bootstrap,u.must_complete_setup,u.last_login_at,COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL),'{}') AS role_codes FROM users u LEFT JOIN employees e ON e.id=u.employee_id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id GROUP BY u.id,e.code,e.full_name ORDER BY u.code");
  return {data:result.rows};
 });
 app.get("/api/roles",{preHandler:[authenticateRequest,requirePermission("users.view")]},async()=>{
  const result=await pool.query("SELECT id,code,name,is_system,is_active FROM roles WHERE is_active=TRUE ORDER BY name");
  return {data:result.rows};
 });
 app.post("/api/users",{preHandler:[authenticateRequest,requirePermission("users.create")]},async(request,reply)=>{
  const parsed=createUserSchema.safeParse(request.body);
  if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات المستخدم غير صحيحة",422);
  const row=await withTransaction(async client=>{
   const role=await client.query("SELECT id FROM roles WHERE code=$1 AND is_active=TRUE",[parsed.data.roleCode]);
   if(!role.rowCount) throw new AppError("ROLE_NOT_FOUND","الدور غير موجود أو غير نشط",422);
   if(parsed.data.employeeId){const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[parsed.data.employeeId]);if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);}
   try{
    const user=await client.query("INSERT INTO users(username,password_hash,employee_id) VALUES($1,$2,$3) RETURNING id,code,username,employee_id,is_active,created_at",[parsed.data.username,hashPassword(parsed.data.password),parsed.data.employeeId??null]);
    const created=user.rows[0];
    await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)",[created.id,role.rows[0].id]);
    await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"iam",entityType:"user",entityId:created.id,afterData:{...created,roleCode:parsed.data.roleCode},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
    return created;
   }catch(error){if((error as {code?:string}).code==="23505")throw new AppError("USERNAME_EXISTS","اسم المستخدم مستخدم بالفعل",409);throw error;}
  });
  return reply.code(201).send({data:row});
 });
 app.patch("/api/users/:id",{preHandler:[authenticateRequest,requirePermission("users.edit")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const parsed=editUserSchema.safeParse(request.body);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات تعديل المستخدم غير صحيحة",422);
  if(id===request.user!.userId && parsed.data.isActive===false)throw new AppError("SELF_DEACTIVATE","لا يمكنك تعطيل حسابك بنفسك",409);
  const row=await withTransaction(async client=>{
   const before=await client.query("SELECT id,code,username,employee_id,is_active,is_bootstrap FROM users WHERE id=$1 FOR UPDATE",[id]);
   if(!before.rowCount)throw new AppError("USER_NOT_FOUND","المستخدم غير موجود",404);
   if(before.rows[0].is_bootstrap)throw new AppError("BOOTSTRAP_LOCKED","حساب الإعداد الأولي لا يمكن إدارته من هنا",409);
   if(parsed.data.roleCode){const role=await client.query("SELECT id FROM roles WHERE code=$1 AND is_active=TRUE",[parsed.data.roleCode]);if(!role.rowCount)throw new AppError("ROLE_NOT_FOUND","الدور غير موجود أو غير نشط",422);await client.query("DELETE FROM user_roles WHERE user_id=$1",[id]);await client.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)",[id,role.rows[0].id]);}
   if(parsed.data.employeeId!==undefined){if(parsed.data.employeeId){const emp=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[parsed.data.employeeId]);if(!emp.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);}await client.query("UPDATE users SET employee_id=$1,updated_at=now() WHERE id=$2",[parsed.data.employeeId,id]);}
   if(parsed.data.isActive!==undefined)await client.query("UPDATE users SET is_active=$1,updated_at=now() WHERE id=$2",[parsed.data.isActive,id]);
   const after=await client.query("SELECT id,code,username,employee_id,is_active,is_bootstrap FROM users WHERE id=$1",[id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"edit",module:"iam",entityType:"user",entityId:id,beforeData:before.rows[0],afterData:after.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return after.rows[0];
  });
  return {data:row};
 });
}