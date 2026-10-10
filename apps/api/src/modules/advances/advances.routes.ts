import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requireAnyPermission, requirePermission } from "../rbac/permission.guard.js";
import { hasPermission } from "../rbac/rbac.service.js";

const createSchema=z.object({
  employeeId:z.string().uuid(),
  amount:z.number().positive(),
  reason:z.string().trim().min(2).max(500),
  repaymentMethod:z.enum(["FIXED_INSTALLMENT","PRODUCTION_PERCENTAGE","CUSTOM"]).default("CUSTOM"),
  installmentAmount:z.number().positive().optional(),
  productionPercentage:z.number().positive().max(100).optional()
}).superRefine((v,ctx)=>{
  if(v.repaymentMethod==="FIXED_INSTALLMENT"&&!v.installmentAmount)ctx.addIssue({code:"custom",path:["installmentAmount"],message:"قيمة القسط مطلوبة"});
  if(v.repaymentMethod==="PRODUCTION_PERCENTAGE"&&!v.productionPercentage)ctx.addIssue({code:"custom",path:["productionPercentage"],message:"نسبة الإنتاج مطلوبة"});
});

const rejectSchema=z.object({reason:z.string().trim().min(2).max(500)});
const repaySchema=z.object({
  amount:z.number().positive(),
  repaymentType:z.enum(["FIXED_INSTALLMENT","PRODUCTION_PERCENTAGE","CUSTOM"]).default("CUSTOM"),
  paymentDate:z.string().date().optional(),
  notes:z.string().trim().max(500).optional()
});

export async function advanceRoutes(app:FastifyInstance){
  // Dedicated employee picker for the advances workflow. Do not depend on employees.view,
  // which is a separate permission and may not be granted to finance/advances operators.
  app.get("/api/advances/eligible-employees",{preHandler:[authenticateRequest,requireAnyPermission(["advances.create","all"],["advances.view","all"])]},async()=>{
    const result=await pool.query("SELECT id,code,full_name FROM employees WHERE is_active=TRUE ORDER BY full_name,code");
    return {data:result.rows};
  });
  app.get("/api/advances",{preHandler:[authenticateRequest,requireAnyPermission(["advances.view","all"],["advances.view_own","own"])]},async(request)=>{
    const q=z.object({status:z.enum(["PENDING","APPROVED","REJECTED","PAID","CANCELLED"]).optional(),employeeId:z.string().uuid().optional()}).safeParse(request.query);
    if(!q.success)throw new AppError("VALIDATION_ERROR","الفلاتر غير صحيحة",422);
    const user=request.user!;
    const scopeClient=await pool.connect();
    let canViewAll=false;
    try{canViewAll=await hasPermission(scopeClient,user.userId,"advances.view","all")}finally{scopeClient.release()}
    const worker=await pool.query("SELECT u.employee_id,EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND r.code='worker' AND r.is_active=TRUE) AS is_worker FROM users u WHERE u.id=$1",[user.userId]);
    const isWorker=Boolean(worker.rows[0]?.is_worker);
    const params:unknown[]=[];const where:string[]=[];
    if(!canViewAll){
      if(!worker.rows[0]?.employee_id)throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
      params.push(worker.rows[0].employee_id);where.push("a.employee_id=$"+params.length);
      if(isWorker){where.push("a.status='PAID'");where.push("a.repayment_status='OPEN'")}
    }else if(q.data.employeeId){
      params.push(q.data.employeeId);where.push("a.employee_id=$"+params.length);
    }
    if(q.data.status&&(!isWorker||canViewAll)){params.push(q.data.status);where.push("a.status=$"+params.length);}
    const r=await pool.query(
      `SELECT a.*,e.code AS employee_code,e.full_name AS employee_name,
              COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0) AS repaid_amount,
              GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0) AS remaining_amount
         FROM advance_requests a JOIN employees e ON e.id=a.employee_id
        ${where.length?"WHERE "+where.join(" AND "):""}
        ORDER BY a.created_at DESC LIMIT 500`,params);
    return {data:r.rows};
  });

  app.post("/api/advances",{preHandler:[authenticateRequest,requirePermission("advances.create")]},async(request,reply)=>{
    const p=createSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات السلفة غير صحيحة",422);
    const r=await withTransaction(async client=>{
      const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[p.data.employeeId]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
      const open=await client.query("SELECT id FROM advance_requests WHERE employee_id=$1 AND status IN ('PENDING','APPROVED','PAID') AND repayment_status='OPEN' LIMIT 1 FOR UPDATE",[p.data.employeeId]);
      if(open.rowCount)throw new AppError("OPEN_ADVANCE_EXISTS","يوجد سلفة مفتوحة بالفعل لهذا الموظف",409);
      const x=await client.query(
        "INSERT INTO advance_requests(employee_id,amount,reason,requested_by,repayment_method,installment_amount,production_percentage) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [p.data.employeeId,p.data.amount,p.data.reason,request.user!.userId,p.data.repaymentMethod,p.data.installmentAmount??null,p.data.productionPercentage??null]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"advances",entityType:"advance_request",entityId:x.rows[0].id,afterData:x.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return x.rows[0];
    });
    return reply.code(201).send({data:r});
  });

  app.post("/api/advances/:id/approve",{preHandler:[authenticateRequest,requirePermission("advances.approve")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const row=await withTransaction(async(client)=>{
      const current=await client.query("SELECT * FROM advance_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount)throw new AppError("NOT_FOUND","طلب السلفة غير موجود",404);
      if(current.rows[0].status!=="PENDING")throw new AppError("INVALID_STATUS","حالة السلفة لا تسمح بالاعتماد",409);
      if(current.rows[0].requested_by===request.user!.userId)throw new AppError("SELF_APPROVAL","لا يمكنك اعتماد سلفة أنشأتها بنفسك",409);
      const updated=await client.query("UPDATE advance_requests SET status='APPROVED',reviewed_by=$1,reviewed_at=now(),updated_at=now() WHERE id=$2 RETURNING *",[request.user!.userId,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"approve",module:"advances",entityType:"advance_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:row};
  });

  app.post("/api/advances/:id/reject",{preHandler:[authenticateRequest,requirePermission("advances.reject")]},async(request)=>{
    const id=(request.params as {id:string}).id;const p=rejectSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","سبب الرفض مطلوب",422);
    const row=await withTransaction(async(client)=>{
      const current=await client.query("SELECT * FROM advance_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount)throw new AppError("NOT_FOUND","السلفة غير موجودة",404);
      if(current.rows[0].status!=="PENDING")throw new AppError("INVALID_STATUS","حالة السلفة لا تسمح بالرفض",409);
      const updated=await client.query("UPDATE advance_requests SET status='REJECTED',rejection_reason=$1,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$3 RETURNING *",[p.data.reason,request.user!.userId,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reject",module:"advances",entityType:"advance_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],metadata:{reason:p.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:row};
  });

  app.post("/api/advances/:id/pay",{preHandler:[authenticateRequest,requirePermission("advances.pay")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const row=await withTransaction(async(client)=>{
      const current=await client.query("SELECT * FROM advance_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount)throw new AppError("NOT_FOUND","السلفة غير موجودة",404);
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

  app.get("/api/advances/:id/repayments",{preHandler:[authenticateRequest,requirePermission("advances.view")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await pool.query("SELECT ar.*,u.username AS created_by_username FROM advance_repayments ar JOIN users u ON u.id=ar.created_by WHERE ar.advance_id=$1 ORDER BY ar.payment_date DESC,ar.created_at DESC",[id]);
    return {data:r.rows};
  });

  app.post("/api/advances/:id/repayments",{preHandler:[authenticateRequest,requirePermission("advances.repay")]},async(request,reply)=>{
    const id=(request.params as {id:string}).id;const p=repaySchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات السداد غير صحيحة",422);
    const result=await withTransaction(async client=>{
      const advance=await client.query("SELECT * FROM advance_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!advance.rowCount)throw new AppError("NOT_FOUND","السلفة غير موجودة",404);
      if(advance.rows[0].status!=="PAID")throw new AppError("INVALID_STATUS","لا يمكن تسجيل السداد قبل صرف السلفة",409);
      if(advance.rows[0].repayment_status==="SETTLED")throw new AppError("ADVANCE_SETTLED","السلفة مسددة بالكامل",409);
      const paid=await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM advance_repayments WHERE advance_id=$1",[id]);
      const remaining=Number(advance.rows[0].amount)-Number(paid.rows[0].amount||0);
      if(p.data.amount>remaining+1e-9)throw new AppError("REPAYMENT_EXCEEDS_BALANCE","مبلغ السداد أكبر من المتبقي",409);
      const x=await client.query("INSERT INTO advance_repayments(advance_id,amount,repayment_type,payment_date,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[id,p.data.amount,p.data.repaymentType,p.data.paymentDate??new Date().toISOString().slice(0,10),p.data.notes??null,request.user!.userId]);
      const next=remaining-p.data.amount;
      const updated=await client.query("UPDATE advance_requests SET repayment_status=$1,updated_at=now() WHERE id=$2 RETURNING *",[next<=1e-9?"SETTLED":"OPEN",id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"repay",module:"advances",entityType:"advance_request",entityId:id,afterData:updated.rows[0],metadata:{repayment:x.rows[0],remaining:next},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {advance:updated.rows[0],repayment:x.rows[0],remaining:next};
    });
    return reply.code(201).send({data:result});
  });
}
