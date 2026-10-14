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
  repaymentMethod:z.enum(["FIXED_INSTALLMENT","SALARY_PERCENTAGE","PRODUCTION_PERCENTAGE","CUSTOM"]).default("CUSTOM"),
  installmentAmount:z.number().positive().optional(),
  salaryPercentage:z.number().positive().max(100).optional(),
  productionPercentage:z.number().positive().max(100).optional(),
  productionPeriodDays:z.number().int().min(1).max(90).default(15),
  productionMinimumEarning:z.number().nonnegative().optional(),
  productionInstallmentAmount:z.number().positive().optional()
}).superRefine((v,ctx)=>{
  if(v.repaymentMethod==="FIXED_INSTALLMENT"&&!v.installmentAmount)ctx.addIssue({code:"custom",path:["installmentAmount"],message:"قيمة القسط الشهري مطلوبة"});
  if(v.repaymentMethod==="SALARY_PERCENTAGE"&&!v.salaryPercentage)ctx.addIssue({code:"custom",path:["salaryPercentage"],message:"نسبة الخصم من الراتب مطلوبة"});
  if(v.repaymentMethod==="PRODUCTION_PERCENTAGE"&&!v.productionPercentage&&!v.productionInstallmentAmount)ctx.addIssue({code:"custom",path:["productionPercentage"],message:"حدد نسبة من الإنتاج أو قيمة قسط ثابت لكل فترة"});
  if(v.repaymentMethod==="PRODUCTION_PERCENTAGE"&&v.productionPercentage&&v.productionInstallmentAmount)ctx.addIssue({code:"custom",path:["productionInstallmentAmount"],message:"اختر نسبة أو قسطًا ثابتًا، وليس الاثنين معًا"});
});

const rejectSchema=z.object({reason:z.string().trim().min(2).max(500)});
const repaySchema=z.object({
  amount:z.number().positive(),
  repaymentType:z.literal("CUSTOM").default("CUSTOM"),
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
              GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0) AS remaining_amount,
              COALESCE((SELECT SUM(l.credit_amount-l.debit_amount) FROM employee_earnings_ledger l WHERE l.employee_id=a.employee_id),0) AS account_balance
         FROM advance_requests a JOIN employees e ON e.id=a.employee_id
        ${where.length?"WHERE "+where.join(" AND "):""}
        ORDER BY a.created_at DESC LIMIT 500`,params);
    return {data:r.rows};
  });

  app.get("/api/advances/my-account",{preHandler:[authenticateRequest,requireAnyPermission(["advances.view_own","own"],["advances.view","all"])]},async(request)=>{
    const employeeId=request.user!.employeeId;
    if(!employeeId)throw new AppError("EMPLOYEE_LINK_REQUIRED","حسابك غير مرتبط بملف موظف؛ اطلب من الإدارة ربط الحساب",403);
    const employee=await pool.query("SELECT id,code,full_name FROM employees WHERE id=$1",[employeeId]);
    if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","ملف الموظف المرتبط بالحساب غير موجود",404);
    const [balance,advances,ledger,scheduledDeductions]=await Promise.all([
      pool.query("SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS balance FROM employee_earnings_ledger WHERE employee_id=$1",[employeeId]),
      pool.query(`SELECT a.id,a.code,a.amount,a.repayment_method,a.installment_amount,a.salary_percentage,a.production_percentage,a.production_period_days,a.production_installment_amount,a.production_minimum_earning,a.status,a.repayment_status,
        COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0) AS repaid_amount,
        GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0) AS remaining_amount
        FROM advance_requests a WHERE a.employee_id=$1 AND a.status='PAID' AND a.repayment_status='OPEN'
        ORDER BY a.paid_at DESC,a.created_at DESC`,[employeeId]),
      pool.query("SELECT id,code,entry_type,credit_amount,debit_amount,notes,created_at FROM employee_earnings_ledger WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 100",[employeeId]),
      pool.query(`SELECT p.period_month,d.amount,a.code AS advance_code,d.repayment_type
        FROM payroll_advance_deductions d
        JOIN payroll_items i ON i.id=d.payroll_item_id
        JOIN payroll_periods p ON p.id=i.period_id
        JOIN advance_requests a ON a.id=d.advance_id
        WHERE a.employee_id=$1 AND p.status IN ('APPROVED','CLOSED') AND i.status<>'PAID'
          AND NOT EXISTS(SELECT 1 FROM advance_repayments ar WHERE ar.advance_id=d.advance_id AND ar.source_payroll_item_id=i.id)
        ORDER BY p.period_month DESC,a.code`,[employeeId])
    ]);
    return {data:{employee:employee.rows[0],accountBalance:Number(balance.rows[0].balance),advances:advances.rows,ledger:ledger.rows,scheduledDeductions:scheduledDeductions.rows}};
  });

  app.post("/api/advances",{preHandler:[authenticateRequest,requirePermission("advances.create")]},async(request,reply)=>{
    const p=createSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات السلفة غير صحيحة",422);
    const r=await withTransaction(async client=>{
      const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[p.data.employeeId]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
      const open=await client.query("SELECT id FROM advance_requests WHERE employee_id=$1 AND status IN ('PENDING','APPROVED') AND repayment_status='OPEN' LIMIT 1 FOR UPDATE",[p.data.employeeId]);
      if(open.rowCount)throw new AppError("OPEN_ADVANCE_EXISTS","يوجد طلب سلفة قيد الاعتماد بالفعل لهذا الموظف",409);
      const x=await client.query(
        "INSERT INTO advance_requests(employee_id,amount,reason,requested_by,repayment_method,installment_amount,salary_percentage,production_percentage,production_period_days,production_minimum_earning,production_installment_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [p.data.employeeId,p.data.amount,p.data.reason,request.user!.userId,p.data.repaymentMethod,p.data.installmentAmount??null,p.data.salaryPercentage??null,p.data.productionPercentage??null,p.data.productionPeriodDays,p.data.productionMinimumEarning??null,p.data.productionInstallmentAmount??null]
      );
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         SELECT DISTINCT u.id,'ADVANCE_REQUEST_CREATED','طلب سلفة جديد للمراجعة',
           'تم تقديم طلب سلفة بقيمة ' || $2::text || ' ج.م. راجع الطلب لاتخاذ الإجراء المناسب.',
           'advance_request',$1::uuid
         FROM users u
         JOIN user_roles ur ON ur.user_id=u.id
         JOIN role_permissions rp ON rp.role_id=ur.role_id
         JOIN permissions p ON p.id=rp.permission_id AND p.code='advances.approve'
         JOIN roles r ON r.id=ur.role_id AND r.is_active=TRUE
         WHERE u.is_active=TRUE AND u.id<>$3`,
        [x.rows[0].id, x.rows[0].amount, request.user!.userId]
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
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         VALUES($1,'ADVANCE_REQUEST_APPROVED','تمت الموافقة على طلب السلفة','تمت الموافقة على طلب السلفة الخاص بك.','advance_request',$2)`,
        [current.rows[0].requested_by, id]
      );
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
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         VALUES($1,'ADVANCE_REQUEST_REJECTED','تم رفض طلب السلفة','سبب الرفض: ' || $2,'advance_request',$3)`,
        [current.rows[0].requested_by, p.data.reason, id]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reject",module:"advances",entityType:"advance_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],metadata:{reason:p.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:row};
  });

  app.post("/api/advances/:id/pay",{preHandler:[authenticateRequest,requirePermission("advances.pay")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const row=await withTransaction(async(client)=>{
      const current=await client.query("SELECT a.*,e.full_name AS employee_name FROM advance_requests a JOIN employees e ON e.id=a.employee_id WHERE a.id=$1 FOR UPDATE OF a",[id]);
      if(!current.rowCount)throw new AppError("NOT_FOUND","السلفة غير موجودة",404);
      if(current.rows[0].status!=="APPROVED")throw new AppError("INVALID_STATUS","يجب اعتماد السلفة قبل صرفها",409);
      const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[current.rows[0].employee_id]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",409);
      const salaryBased=["FIXED_INSTALLMENT","SALARY_PERCENTAGE"].includes(current.rows[0].repayment_method);
      const salaryProfile=salaryBased?await client.query("SELECT 1 FROM employee_salary_profiles WHERE employee_id=$1 AND effective_from<=CURRENT_DATE AND (effective_to IS NULL OR effective_to>=CURRENT_DATE) LIMIT 1",[current.rows[0].employee_id]):{rowCount:0,rows:[] as any[]};
      if(salaryBased&&!salaryProfile.rowCount)throw new AppError("SALARY_PROFILE_REQUIRED","لا يمكن صرف سلفة بقسط شهري أو نسبة من الراتب قبل تعريف راتب أساسي ساري للموظف",409);
      if(!request.user!.employeeId)throw new AppError("CUSTODY_EMPLOYEE_REQUIRED","اربط حساب الصارف بملف موظف/عهدة قبل صرف السلفة حتى تُسجل حركة الخزنة",409);
      const ledger=await client.query("INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes) VALUES($1,'ADJUSTMENT',$2,$3,$4) RETURNING id,code",[current.rows[0].employee_id,current.rows[0].amount,request.user!.userId,"صرف سلفة "+current.rows[0].code]);
      const cash=await client.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'OUT',$2,CURRENT_DATE,$3,$4,'ADVANCE_PAYOUT',$5,$6) RETURNING id",
        [request.user!.employeeId,current.rows[0].amount,"صرف سلفة "+current.rows[0].code,"سلفة الموظف "+current.rows[0].employee_name,id,request.user!.userId]
      );
      const updated=await client.query("UPDATE advance_requests SET status='PAID',paid_by=$1,paid_at=now(),ledger_entry_id=$2,updated_at=now() WHERE id=$3 RETURNING *",[request.user!.userId,ledger.rows[0].id,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"pay",module:"advances",entityType:"advance_request",entityId:id,afterData:updated.rows[0],metadata:{ledger_code:ledger.rows[0].code,cash_custody_transaction_id:cash.rows[0].id,salary_based:Boolean(salaryProfile.rowCount)},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
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
    const id=(request.params as {id:string}).id;const p=repaySchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات دفعة سداد السلفة غير صحيحة",422);
    const result=await withTransaction(async client=>{
      const advance=await client.query("SELECT a.*,e.full_name AS employee_name FROM advance_requests a JOIN employees e ON e.id=a.employee_id WHERE a.id=$1 FOR UPDATE OF a",[id]);
      if(!advance.rowCount)throw new AppError("NOT_FOUND","السلفة غير موجودة",404);
      if(advance.rows[0].status!=="PAID")throw new AppError("INVALID_STATUS","لا يمكن تسجيل السداد قبل صرف السلفة",409);
      if(advance.rows[0].repayment_status==="SETTLED")throw new AppError("ADVANCE_SETTLED","السلفة مسددة بالكامل",409);
      const paid=await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM advance_repayments WHERE advance_id=$1",[id]);
      const remaining=Number(advance.rows[0].amount)-Number(paid.rows[0].amount||0);
      if(p.data.amount>remaining+1e-9)throw new AppError("REPAYMENT_EXCEEDS_BALANCE","مبلغ السداد أكبر من المتبقي",409);
      if(!request.user!.employeeId)throw new AppError("CUSTODY_EMPLOYEE_REQUIRED","اربط حساب مستلم السداد بملف موظف/عهدة حتى تُسجل حركة الداخل",409);
      const x=await client.query("INSERT INTO advance_repayments(advance_id,amount,repayment_type,payment_date,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[id,p.data.amount,p.data.repaymentType,p.data.paymentDate??new Date().toISOString().slice(0,10),p.data.notes??null,request.user!.userId]);
      const ledger=await client.query(
        `INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,created_by,notes,advance_repayment_id)
         VALUES($1,'ADJUSTMENT',$2,$3,$4,$5)
         ON CONFLICT (advance_repayment_id) WHERE advance_repayment_id IS NOT NULL DO NOTHING RETURNING id`,
        [advance.rows[0].employee_id,p.data.amount,request.user!.userId,"سداد نقدي من سلفة "+advance.rows[0].employee_name+" ("+advance.rows[0].code+")",x.rows[0].id]);
      const cash=await client.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'IN',$2,COALESCE($3::date,CURRENT_DATE),$4,$5,'ADVANCE_REPAYMENT',$6,$7) RETURNING id",
        [request.user!.employeeId,p.data.amount,p.data.paymentDate??null,"تحصيل سداد سلفة "+advance.rows[0].employee_name+" ("+advance.rows[0].code+")",p.data.notes??null,x.rows[0].id,request.user!.userId]
      );
      const next=remaining-p.data.amount;
      const updated=await client.query("UPDATE advance_requests SET repayment_status=$1,updated_at=now() WHERE id=$2 RETURNING *",[next<=1e-9?"SETTLED":"OPEN",id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"repay",module:"advances",entityType:"advance_request",entityId:id,afterData:updated.rows[0],metadata:{repayment:x.rows[0],remaining:next,earnings_ledger_entry_id:ledger.rows[0].id,cash_custody_transaction_id:cash.rows[0].id},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {advance:updated.rows[0],repayment:x.rows[0],remaining:next};
    });
    return reply.code(201).send({data:result});
  });
}
