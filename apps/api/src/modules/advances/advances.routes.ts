import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const createSchema=z.object({amount:z.number().positive(),reason:z.string().trim().min(2).max(500)});
const rejectSchema=z.object({reason:z.string().trim().min(2).max(500)});

async function workerInfo(userId:string){
 const r=await pool.query("SELECT u.employee_id,EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.code='worker' AND r.is_active=TRUE) AS is_worker FROM users u WHERE u.id=$1",[userId]);
 return r.rows[0]??null;
}

export async function advanceRoutes(app:FastifyInstance){
 app.get("/api/advances",{preHandler:[authenticateRequest,requirePermission("advances.view")]},async(request)=>{
  const q=z.object({status:z.enum(["PENDING","APPROVED","REJECTED","PAID","CANCELLED"]).optional()}).safeParse(request.query);
  if(!q.success) throw new AppError("VALIDATION_ERROR","الفلاتر غير صحيحة",422);
  const user=await workerInfo(request.user!.userId); const params:unknown[]=[]; const where:string[]=[];
  if(user?.is_worker){if(!user.employee_id)throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);params.push(user.employee_id);where.push("a.employee_id=$"+params.length);}
  if(q.data.status){params.push(q.data.status);where.push("a.status=$"+params.length);}
  const r=await pool.query("SELECT a.*,e.code AS employee_code,e.full_name AS employee_name FROM advance_requests a JOIN employees e ON e.id=a.employee_id "+(where.length?"WHERE "+where.join(" AND "):"")+" ORDER BY a.created_at DESC LIMIT 300",params);
  return {data:r.rows};
 });

 app.post("/api/advances",{preHandler:[authenticateRequest,requirePermission("advances.create","own")]},async(request,reply)=>{
  const parsed=createSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات السلفة غير صحيحة",422);
  const user=await workerInfo(request.user!.userId);if(!user?.is_worker||!user.employee_id)throw new AppError("WORKER_ONLY","طلب السلفة متاح للعامل فقط",403);
  const open=await pool.query("SELECT id FROM advance_requests WHERE employee_id=$1 AND status IN ('PENDING','APPROVED') LIMIT 1",[user.employee_id]);
  if(open.rowCount)throw new AppError("OPEN_ADVANCE_EXISTS","يوجد طلب سلفة مفتوح بالفعل",409);
  const r=await pool.query("INSERT INTO advance_requests(employee_id,amount,reason,requested_by) VALUES($1,$2,$3,$4) RETURNING *",[user.employee_id,parsed.data.amount,parsed.data.reason,request.user!.userId]);
  return reply.code(201).send({data:r.rows[0]});
 });

 app.post("/api/advances/:id/approve",{preHandler:[authenticateRequest,requirePermission("advances.approve")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const row=await withTransaction(async(client)=>{
   const current=await client.query("SELECT * FROM advance_requests WHERE id=$1 FOR UPDATE",[id]);
   if(!current.rowCount)throw new AppError("NOT_FOUND","طلب السلفة غير موجود",404);
   if(current.rows[0].status!=="PENDING")throw new AppError("INVALID_STATUS","حالة الطلب لا تسمح بالاعتماد",409);
   if(current.rows[0].requested_by===request.user!.userId)throw new AppError("SELF_APPROVAL","لا يمكنك اعتماد طلب سلفة أنشأته بنفسك",409);
   const updated=await client.query("UPDATE advance_requests SET status='APPROVED',reviewed_by=$1,reviewed_at=now(),updated_at=now() WHERE id=$2 RETURNING *",[request.user!.userId,id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"approve",module:"advances",entityType:"advance_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:row};
 });

 app.post("/api/advances/:id/reject",{preHandler:[authenticateRequest,requirePermission("advances.reject")]},async(request)=>{
  const id=(request.params as {id:string}).id;const parsed=rejectSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","سبب الرفض مطلوب",422);
  const row=await withTransaction(async(client)=>{
   const current=await client.query("SELECT * FROM advance_requests WHERE id=$1 FOR UPDATE",[id]);
   if(!current.rowCount)throw new AppError("NOT_FOUND","طلب السلفة غير موجود",404);
   if(current.rows[0].status!=="PENDING")throw new AppError("INVALID_STATUS","حالة الطلب لا تسمح بالرفض",409);
   const updated=await client.query("UPDATE advance_requests SET status='REJECTED',rejection_reason=$1,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$3 RETURNING *",[parsed.data.reason,request.user!.userId,id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reject",module:"advances",entityType:"advance_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],metadata:{reason:parsed.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:row};
 });

 app.post("/api/advances/:id/pay",{preHandler:[authenticateRequest,requirePermission("advances.pay")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const row=await withTransaction(async(client)=>{
   const current=await client.query("SELECT * FROM advance_requests WHERE id=$1 FOR UPDATE",[id]);
   if(!current.rowCount)throw new AppError("NOT_FOUND","طلب السلفة غير موجود",404);
   if(current.rows[0].status!=="APPROVED")throw new AppError("INVALID_STATUS","يجب اعتماد السلفة قبل صرفها",409);
   const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[current.rows[0].employee_id]);
   if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",409);
   const balance=await client.query("SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",[current.rows[0].employee_id]);
   if(Number(current.rows[0].amount)>Number(balance.rows[0]?.balance??0))throw new AppError("INSUFFICIENT_BALANCE","المستحق المتاح لا يكفي لصرف السلفة",409);
   const ledger=await client.query("INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',$2,$3,$4) RETURNING id,code",[current.rows[0].employee_id,current.rows[0].amount,request.user!.userId,"Advance paid: "+current.rows[0].code]);
   const updated=await client.query("UPDATE advance_requests SET status='PAID',paid_by=$1,paid_at=now(),ledger_entry_id=$2,updated_at=now() WHERE id=$3 RETURNING *",[request.user!.userId,ledger.rows[0].id,id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"pay",module:"advances",entityType:"advance_request",entityId:id,afterData:updated.rows[0],metadata:{ledger_code:ledger.rows[0].code},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:row};
 });
}