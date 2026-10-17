import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const expenseSchema=z.object({
  orderId:z.string().uuid().nullable().optional(),
  orderStageId:z.string().uuid().nullable().optional(),
  category:z.string().trim().min(2).max(100),
  description:z.string().trim().min(2).max(300),
  amount:z.number().positive().refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,{message:"المبلغ يجب أن يكون بحد أقصى منزلتين عشريتين"}),
  expenseDate:z.string().date().optional(),
  paymentMethod:z.string().trim().max(50).nullable().optional(),
  expenseType:z.enum(["DIRECT","ADMINISTRATIVE"]).default("DIRECT"),
  paidFromEmployeeId:z.string().uuid().nullable().optional(),
  idempotencyKey:z.string().uuid().optional()
}).superRefine((v,ctx)=>{
  if(v.expenseType==="ADMINISTRATIVE"&&(v.orderId||v.orderStageId)){
    ctx.addIssue({code:"custom",path:["orderId"],message:"المصروف الإداري يوزع على الطلبيات وقت التصفية ولا يرتبط بطلبية أو مرحلة واحدة"});
  }
  if(v.orderStageId&&!v.orderId){
    ctx.addIssue({code:"custom",path:["orderId"],message:"اختيار مرحلة إنتاج يتطلب اختيار الطلبية أولًا"});
  }
});
const revenueSchema=z.object({
  orderId:z.string().uuid().nullable().optional(),
  amount:z.number().positive().refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,{message:"المبلغ يجب أن يكون بحد أقصى منزلتين عشريتين"}),
  revenueDate:z.string().date().optional(),
  source:z.string().trim().min(2).max(50).default("MANUAL").refine(v=>v.toUpperCase()!=="EXTERNAL_CUSTODY_TOP_UP",{message:"تمويل العهدة لا يُسجَّل كإيراد؛ استخدم إجراء تمويل العهدة"}),
  notes:z.string().trim().max(500).nullable().optional(),
  idempotencyKey:z.string().uuid().optional()
});
const idSchema=z.object({orderId:z.string().uuid()});

async function assertAccountingDateOpen(client:import("pg").PoolClient,date:string|undefined){
 // Lock the matching period row so closing the period cannot race with a posting.
 const result=await client.query("SELECT id,name,status FROM accounting_periods WHERE COALESCE($1::date,current_date) BETWEEN period_start AND period_end ORDER BY period_start LIMIT 1 FOR SHARE",[date??null]);
 if(result.rows[0]&&result.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_CLOSED","الفترة المالية ليست مفتوحة؛ لا يمكن تسجيل حركة عادية عليها. استخدم إجراء التصحيح المعتمد.",409);
}

export async function accountingRoutes(app:FastifyInstance){
 app.get("/api/accounting/expenses",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view")]},async(request)=>{
  const q=z.object({orderId:z.string().uuid().optional()}).safeParse(request.query);
  if(!q.success)throw new AppError("VALIDATION_ERROR","فلتر المصروفات غير صحيح",422);
  const params:unknown[]=[];let where="";
  if(q.data.orderId){params.push(q.data.orderId);where=" WHERE e.order_id=$1 ";}
  const r=await pool.query(`SELECT e.*,o.code AS order_code,o.order_name,os.sequence_no AS stage_sequence_no,st.name AS stage_name,u.username AS created_by_username
    FROM accounting_expenses e
    LEFT JOIN production_orders o ON o.id=e.order_id
    LEFT JOIN order_stages os ON os.id=e.order_stage_id
    LEFT JOIN stages st ON st.id=os.stage_id
    LEFT JOIN users u ON u.id=e.created_by
    ${where} ORDER BY e.expense_date DESC,e.created_at DESC`,params);
  return {data:r.rows};
 });

 app.post("/api/accounting/expenses",{preHandler:[authenticateRequest,requirePermission("finance.expenses.create")]},async(request,reply)=>{
  const p=expenseSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات المصروف غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   const payloadHash=p.data.idempotencyKey?createHash("sha256").update(JSON.stringify({
    orderId:p.data.orderId??null,orderStageId:p.data.orderStageId??null,category:p.data.category,
    description:p.data.description,amountMinor:Math.round(p.data.amount*100),expenseDate:p.data.expenseDate??null,
    paymentMethod:p.data.paymentMethod??null,expenseType:p.data.expenseType,paidFromEmployeeId:p.data.paidFromEmployeeId??null
   })).digest("hex"):null;
   if(p.data.idempotencyKey){
    const prior=await client.query("SELECT * FROM accounting_expenses WHERE idempotency_key=$1 FOR SHARE",[p.data.idempotencyKey]);
    if(prior.rowCount){
     if(prior.rows[0].idempotency_payload_hash!==payloadHash)throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح العملية مستخدم لمصروف ببيانات مختلفة؛ ابدأ عملية جديدة بمفتاح جديد.",409);
     return prior.rows[0];
    }
   }
   // Use a consistent lock order for order-linked postings: order -> employee -> stage -> period.
   if(p.data.orderId){
    const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[p.data.orderId]);
    if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
    if(p.data.idempotencyKey){
     const concurrentPrior=await client.query("SELECT * FROM accounting_expenses WHERE idempotency_key=$1 FOR SHARE",[p.data.idempotencyKey]);
     if(concurrentPrior.rowCount){
      if(concurrentPrior.rows[0].idempotency_payload_hash!==payloadHash)throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح العملية مستخدم لمصروف ببيانات مختلفة؛ ابدأ عملية جديدة بمفتاح جديد.",409);
      return concurrentPrior.rows[0];
     }
    }
    if(order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","لا يمكن تسجيل مصروف على طلبية ملغاة",409);
    if(order.rows[0].status==="COMPLETED")throw new AppError("ORDER_NOT_EXPENSABLE","لا يمكن تسجيل مصروف جديد على طلبية مكتملة؛ أعد فتحها أولًا",409);
   }
   if(p.data.paidFromEmployeeId){
    const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[p.data.paidFromEmployeeId]);
    if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
   }
   if(p.data.orderStageId){
    const stage=await client.query("SELECT id,order_id,status FROM order_stages WHERE id=$1 FOR SHARE",[p.data.orderStageId]);
    if(!stage.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الإنتاج غير موجودة",404);
    if(stage.rows[0].order_id!==p.data.orderId)throw new AppError("ORDER_STAGE_ORDER_MISMATCH","مرحلة الإنتاج لا تتبع الطلبية المختارة",422);
    if(stage.rows[0].status==="CANCELLED")throw new AppError("ORDER_STAGE_CANCELLED","لا يمكن تحميل مصروف على مرحلة ملغاة",409);
   }
   await assertAccountingDateOpen(client,p.data.expenseDate);
   let r;
   if(p.data.idempotencyKey){
    r=await client.query("INSERT INTO accounting_expenses(order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,expense_type,paid_from_employee_id,idempotency_key,idempotency_payload_hash) VALUES($1,$2,$3,$4,$5,COALESCE($6,current_date),$7,$8,$9,$10,$11,$12) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *",
     [p.data.orderId??null,p.data.orderStageId??null,p.data.category,p.data.description,p.data.amount,p.data.expenseDate??null,p.data.paymentMethod??null,request.user!.userId,p.data.expenseType,p.data.paidFromEmployeeId??null,p.data.idempotencyKey,payloadHash]);
    if(!r.rowCount){
     const prior=await client.query("SELECT * FROM accounting_expenses WHERE idempotency_key=$1 FOR SHARE",[p.data.idempotencyKey]);
     if(!prior.rowCount)throw new AppError("EXPENSE_RETRY_CONFLICT","تعذر استرجاع المصروف السابق؛ أعد المحاولة بنفس المفتاح.",409);
     if(prior.rows[0].idempotency_payload_hash!==payloadHash)throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح العملية مستخدم لمصروف ببيانات مختلفة؛ ابدأ عملية جديدة بمفتاح جديد.",409);
     return prior.rows[0];
    }
   }else{
    r=await client.query("INSERT INTO accounting_expenses(order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,expense_type,paid_from_employee_id) VALUES($1,$2,$3,$4,$5,COALESCE($6,current_date),$7,$8,$9,$10) RETURNING *",
     [p.data.orderId??null,p.data.orderStageId??null,p.data.category,p.data.description,p.data.amount,p.data.expenseDate??null,p.data.paymentMethod??null,request.user!.userId,p.data.expenseType,p.data.paidFromEmployeeId??null]);
   }
   if(p.data.paidFromEmployeeId){
    // Posting the expense and its cash-custody outflow is atomic; a negative balance is allowed for factory spending.
    const cash=await client.query("INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'OUT',$2,COALESCE($3::date,current_date),$4,$5,'ACCOUNTING_EXPENSE',$6,$7) RETURNING id",
      [p.data.paidFromEmployeeId,p.data.amount,p.data.expenseDate??null,p.data.description,"صرف مصروف: "+p.data.category,r.rows[0].id,request.user!.userId]);
    r=await client.query("UPDATE accounting_expenses SET cash_custody_transaction_id=$1 WHERE id=$2 RETURNING *",[cash.rows[0].id,r.rows[0].id]);
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"finance",entityType:"expense",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });

 app.get("/api/accounting/revenues",{preHandler:[authenticateRequest,requirePermission("finance.revenues.view")]},async()=>{
  const r=await pool.query("SELECT r.*,o.code AS order_code,o.order_name,u.username AS created_by_username FROM order_revenues r LEFT JOIN production_orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=r.created_by WHERE UPPER(r.source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP' ORDER BY r.revenue_date DESC,r.created_at DESC");
  return {data:r.rows};
 });

 app.post("/api/accounting/revenues",{preHandler:[authenticateRequest,requirePermission("finance.revenues.create")]},async(request,reply)=>{
  const p=revenueSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الإيراد غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   const payloadHash=p.data.idempotencyKey?createHash("sha256").update(JSON.stringify({
    orderId:p.data.orderId??null,amountMinor:Math.round(p.data.amount*100),revenueDate:p.data.revenueDate??null,
    source:p.data.source,notes:p.data.notes??null
   })).digest("hex"):null;
   if(p.data.idempotencyKey){
    const prior=await client.query("SELECT * FROM order_revenues WHERE idempotency_key=$1 FOR SHARE",[p.data.idempotencyKey]);
    if(prior.rowCount){
     if(prior.rows[0].idempotency_payload_hash!==payloadHash)throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح العملية مستخدم لإيراد ببيانات مختلفة؛ ابدأ عملية جديدة بمفتاح جديد.",409);
     return prior.rows[0];
    }
   }
   if(p.data.orderId){
     // Serialize order-linked revenue against collections and contract edits.
     const order=await client.query("SELECT id,status,COALESCE(contract_value,0) AS contract_value FROM production_orders WHERE id=$1 FOR UPDATE",[p.data.orderId]);
     if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
     if(p.data.idempotencyKey){
      const concurrentPrior=await client.query("SELECT * FROM order_revenues WHERE idempotency_key=$1 FOR SHARE",[p.data.idempotencyKey]);
      if(concurrentPrior.rowCount){
       if(concurrentPrior.rows[0].idempotency_payload_hash!==payloadHash)throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح العملية مستخدم لإيراد ببيانات مختلفة؛ ابدأ عملية جديدة بمفتاح جديد.",409);
       return concurrentPrior.rows[0];
      }
     }
     if(order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","لا يمكن تسجيل إيراد على طلبية ملغاة",409);
     if(order.rows[0].status==="COMPLETED")throw new AppError("ORDER_NOT_COLLECTIBLE","لا يمكن تسجيل إيراد جديد على طلبية مكتملة؛ أعد فتحها أولًا",409);
     await assertAccountingDateOpen(client,p.data.revenueDate);
     const contractValue=Number(order.rows[0].contract_value||0);
     if(contractValue>0){
       const posted=await client.query("SELECT COALESCE(SUM(amount),0) AS total FROM order_revenues WHERE order_id=$1 AND UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'",[p.data.orderId]);
       const collected=Number(posted.rows[0]?.total||0);
       if(collected+p.data.amount>contractValue+1e-7)throw new AppError("CONTRACT_VALUE_EXCEEDED","قيمة الإيرادات المسجلة ستتجاوز قيمة التعاقد؛ سجّل التحصيل من المتبقي المتاح فقط",409);
     }
   }else{
     await assertAccountingDateOpen(client,p.data.revenueDate);
   }
   const codeResult=await client.query("SELECT 'REV-' || lpad(nextval('revenue_code_seq')::text,8,'0') AS code");
   const code=codeResult.rows[0].code;
   let r;
   if(p.data.idempotencyKey){
    r=await client.query("INSERT INTO order_revenues(order_id,code,amount,revenue_date,source,notes,created_by,idempotency_key,idempotency_payload_hash) VALUES($1,$2,$3,COALESCE($4,current_date),$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *",
     [p.data.orderId??null,code,p.data.amount,p.data.revenueDate??null,p.data.source,p.data.notes??null,request.user!.userId,p.data.idempotencyKey,payloadHash]);
    if(!r.rowCount){
     const prior=await client.query("SELECT * FROM order_revenues WHERE idempotency_key=$1 FOR SHARE",[p.data.idempotencyKey]);
     if(!prior.rowCount)throw new AppError("REVENUE_RETRY_CONFLICT","تعذر استرجاع الإيراد السابق؛ أعد المحاولة بنفس المفتاح.",409);
     if(prior.rows[0].idempotency_payload_hash!==payloadHash)throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح العملية مستخدم لإيراد ببيانات مختلفة؛ ابدأ عملية جديدة بمفتاح جديد.",409);
     return prior.rows[0];
    }
   }else{
    r=await client.query("INSERT INTO order_revenues(order_id,code,amount,revenue_date,source,notes,created_by) VALUES($1,$2,$3,COALESCE($4,current_date),$5,$6,$7) RETURNING *",[p.data.orderId??null,code,p.data.amount,p.data.revenueDate??null,p.data.source,p.data.notes??null,request.user!.userId]);
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"finance",entityType:"revenue",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });

 app.get("/api/accounting/summary",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view"),requirePermission("finance.revenues.view")]},async()=>{
  const r=await pool.query(`
    SELECT
      COALESCE((SELECT SUM(amount) FROM order_revenues WHERE UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'),0) AS total_in,
      COALESCE((SELECT SUM(amount) FROM accounting_expenses),0) AS total_out,
      COALESCE((SELECT SUM(amount) FROM order_revenues WHERE UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'),0)-COALESCE((SELECT SUM(amount) FROM accounting_expenses),0) AS net,
      COALESCE((SELECT COUNT(*) FROM order_revenues WHERE UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'),0)::int AS revenue_count,
      COALESCE((SELECT COUNT(*) FROM accounting_expenses),0)::int AS expense_count,
      COALESCE((SELECT SUM(amount) FROM accounting_expenses WHERE order_id IS NULL),0) AS general_expenses,
      COALESCE((SELECT SUM(amount) FROM order_revenues WHERE order_id IS NULL AND UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'),0) AS general_income`);
  return {data:r.rows[0]};
 });


 const periodSchema=z.object({
  name:z.string().trim().min(2).max(120),
  periodStart:z.string().date(),
  periodEnd:z.string().date(),
  notes:z.string().trim().max(1000).nullable().optional()
 }).refine(v=>v.periodEnd>=v.periodStart,{message:"تاريخ نهاية الفترة يجب أن يكون بعد بدايتها",path:["periodEnd"]});
 const allocationSchema=z.object({
  allocations:z.array(z.object({
   expenseId:z.string().uuid(),
   orderId:z.string().uuid(),
   amount:z.number().nonnegative().refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,{message:"مبلغ التوزيع يجب أن يكون بحد أقصى منزلتين عشريتين"})
  }))
 });
 const toMinorUnits=(value:unknown)=>Math.round(Number(value||0)*100);
 const hasCentPrecision=(value:unknown)=>Math.abs(Number(value||0)*100-toMinorUnits(value))<1e-7;
 app.get("/api/accounting/periods",{preHandler:[authenticateRequest,requirePermission("finance.period_close.view")]},async()=>{
  const r=await pool.query(`SELECT p.*,
    (SELECT COUNT(*)::int FROM accounting_expense_allocations a WHERE a.period_id=p.id) AS allocation_count,
    COALESCE((SELECT SUM(amount) FROM accounting_expense_allocations a WHERE a.period_id=p.id),0) AS allocated_amount
    FROM accounting_periods p ORDER BY p.period_start DESC,p.created_at DESC`);
  return {data:r.rows};
 });
 app.post("/api/accounting/periods",{preHandler:[authenticateRequest,requirePermission("finance.period_close.create")]},async(request,reply)=>{
  const p=periodSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الفترة المالية غير صحيحة",422);
  const row=await withTransaction(async client=>{
   // Serialize period creation so concurrent requests cannot both pass the overlap check.
   await client.query("SELECT pg_advisory_xact_lock(hashtext('tezkar_accounting_period_overlap'))");
   const overlap=await client.query("SELECT id FROM accounting_periods WHERE period_start<=$2::date AND period_end>=$1::date LIMIT 1",[p.data.periodStart,p.data.periodEnd]);
   if(overlap.rowCount)throw new AppError("ACCOUNTING_PERIOD_OVERLAP","الفترة تتداخل مع فترة مالية مسجلة بالفعل",409);
   const r=await client.query("INSERT INTO accounting_periods(name,period_start,period_end,notes,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",[p.data.name,p.data.periodStart,p.data.periodEnd,p.data.notes??null,request.user!.userId]);
   const previous=await client.query("SELECT p.id,s.report FROM accounting_periods p JOIN accounting_period_close_snapshots s ON s.period_id=p.id WHERE p.status='CLOSED' AND p.period_end<$1::date ORDER BY p.period_end DESC,s.snapshot_no DESC LIMIT 1 FOR SHARE OF p",[p.data.periodStart]);
   if(previous.rowCount){
    const report=previous.rows[0].report as {cashCustody?:Array<Record<string,unknown>>;workerDues?:Array<Record<string,unknown>>;advances?:Array<Record<string,unknown>>;inventory?:Array<Record<string,unknown>>};
    const sourceId=previous.rows[0].id;
    for(const row of report.cashCustody??[]) await client.query("INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'CASH_CUSTODY',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO NOTHING",[r.rows[0].id,sourceId,String(row.employee_id),JSON.stringify(row)]);
    for(const row of report.workerDues??[]) await client.query("INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'WORKER_DUES',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO NOTHING",[r.rows[0].id,sourceId,String(row.employee_id),JSON.stringify(row)]);
    for(const row of report.advances??[]) if(Number(row.remaining)>0) await client.query("INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'ADVANCE',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO NOTHING",[r.rows[0].id,sourceId,String(row.id),JSON.stringify(row)]);
    for(const row of report.inventory??[]) await client.query("INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'INVENTORY',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO NOTHING",[r.rows[0].id,sourceId,[row.product_id,row.warehouse_id,row.location_id??''].join(':'),JSON.stringify(row)]);
    await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"carry_forward",module:"finance",entityType:"accounting_period",entityId:r.rows[0].id,afterData:{sourcePeriodId:sourceId,openingBalanceTypes:["CASH_CUSTODY","WORKER_DUES","ADVANCE","INVENTORY"]},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"finance",entityType:"accounting_period",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });
 app.get("/api/accounting/periods/:id",{preHandler:[authenticateRequest,requirePermission("finance.period_close.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const period=await pool.query("SELECT * FROM accounting_periods WHERE id=$1",[id]);
  if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
  const [expenses,allocations,openingBalances]=await Promise.all([
   pool.query("SELECT e.id,e.code,e.category,e.description,e.amount,e.expense_date FROM accounting_expenses e WHERE e.expense_type='ADMINISTRATIVE' AND e.expense_date BETWEEN $1 AND $2 ORDER BY e.expense_date,e.created_at",[period.rows[0].period_start,period.rows[0].period_end]),
   pool.query("SELECT a.*,e.code AS expense_code,e.description AS expense_description,o.code AS order_code,o.order_name FROM accounting_expense_allocations a JOIN accounting_expenses e ON e.id=a.expense_id JOIN production_orders o ON o.id=a.order_id WHERE a.period_id=$1 ORDER BY e.expense_date,e.created_at,o.code",[id]),
   pool.query("SELECT balance_type,entity_key,balance,source_period_id,created_at FROM accounting_period_opening_balances WHERE period_id=$1 ORDER BY balance_type,entity_key",[id])
  ]);
  const orders=await pool.query("SELECT id,code,order_name,status FROM production_orders WHERE status<>'CANCELLED' ORDER BY created_at DESC");
  return {data:{period:period.rows[0],expenses:expenses.rows,allocations:allocations.rows,openingBalances:openingBalances.rows,orders:orders.rows}};
 });
 app.post("/api/accounting/periods/:id/auto-allocate",{preHandler:[authenticateRequest,requirePermission("finance.period_close.create")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_CLOSED","لا يمكن تعديل فترة مقفلة",409);
   const expenses=await client.query("SELECT id,amount FROM accounting_expenses WHERE expense_type='ADMINISTRATIVE' AND expense_date BETWEEN $1 AND $2 ORDER BY id",[period.rows[0].period_start,period.rows[0].period_end]);
   if(!expenses.rowCount)throw new AppError("NO_ADMIN_EXPENSES","لا توجد مصروفات إدارية في هذه الفترة",409);
   const orders=await client.query(`SELECT o.id,
    COALESCE((SELECT SUM(e.amount) FROM accounting_expenses e WHERE e.order_id=o.id AND e.expense_type='DIRECT'),0)
    +COALESCE((SELECT SUM(sm.total_cost) FROM stock_movements sm WHERE sm.order_id=o.id AND sm.movement_type='OUT' AND sm.reference_type IS DISTINCT FROM 'DELIVERY'),0)
    +COALESCE((SELECT SUM(COALESCE(pe.total_earning_amount,pe.earning_amount)) FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=o.id AND pe.status='APPROVED'),0)
    +COALESCE((SELECT SUM(pci.delta_amount) FROM order_price_change_items pci JOIN production_entries pe ON pe.id=pci.production_entry_id JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=o.id AND pe.status='APPROVED' AND pci.ledger_adjustment=TRUE),0) AS cost
    FROM production_orders o WHERE o.status<>'CANCELLED' ORDER BY o.code`);
   const eligibleOrders=orders.rows.filter(row=>Number(row.cost||0)>0);
   const totalCost=eligibleOrders.reduce((sum,row)=>sum+Number(row.cost||0),0);
   if(!eligibleOrders.length||totalCost<=0)throw new AppError("NO_COST_BASIS","لا توجد تكاليف موجبة للطلبيات يمكن توزيع المصروفات عليها",409);
   await client.query("DELETE FROM accounting_expense_allocations WHERE period_id=$1",[id]);
   let allocationCount=0;
   for(const expense of expenses.rows){
    if(!hasCentPrecision(expense.amount))throw new AppError("EXPENSE_PRECISION_UNSUPPORTED","يوجد مصروف مسجل بأجزاء من القرش؛ صحح دقته بتسوية موثقة قبل التصفية",409);
    const amountMinor=toMinorUnits(expense.amount);
    const rawShares=eligibleOrders.map(order=>amountMinor*Number(order.cost||0)/totalCost);
    const shares=rawShares.map(Math.floor);
    let centsRemaining=amountMinor-shares.reduce((sum,value)=>sum+value,0);
    const remainderOrder=rawShares.map((raw,index)=>({index,remainder:raw-(shares[index]??0)})).sort((a,b)=>b.remainder-a.remainder);
    for(let i=0;i<centsRemaining;i++){
     const remainder=remainderOrder[i];
     if(remainder)shares[remainder.index]=(shares[remainder.index]??0)+1;
    }
    for(let i=0;i<eligibleOrders.length;i++){
     const order=eligibleOrders[i];
     const share=shares[i];
     if(!order||share===undefined)throw new AppError("ALLOCATION_ROUNDING_ERROR","تعذر موازنة توزيع المصروفات إلى القرش",500);
     // Zero-cent shares do not represent a real allocation; omit them while
     // preserving the exact per-expense total through largest-remainder rounding.
     if(share===0)continue;
     await client.query("INSERT INTO accounting_expense_allocations(period_id,expense_id,order_id,amount,created_by) VALUES($1,$2,$3,$4,$5)",[id,expense.id,order.id,share/100,request.user!.userId]);
     allocationCount++;
    }
    if(shares.reduce((sum,value)=>sum+value,0)!==amountMinor)throw new AppError("ALLOCATION_ROUNDING_ERROR","تعذر موازنة توزيع المصروفات إلى القرش",500);
   }
   const result=await client.query("SELECT COALESCE(SUM(amount),0) AS allocated FROM accounting_expense_allocations WHERE period_id=$1",[id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"auto_allocate",module:"finance",entityType:"accounting_period",entityId:id,afterData:{periodId:id,expenseCount:expenses.rowCount,allocationCount,allocatedAmount:result.rows[0].allocated},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return {periodId:id,expenseCount:expenses.rowCount,allocationCount,allocatedAmount:result.rows[0].allocated};
  })};
 });
 app.put("/api/accounting/periods/:id/allocations",{preHandler:[authenticateRequest,requirePermission("finance.period_close.create")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const p=allocationSchema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات توزيع المصروفات غير صحيحة",422);
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_CLOSED","لا يمكن تعديل فترة مقفلة",409);
   const expenses=await client.query("SELECT id,amount FROM accounting_expenses WHERE expense_type='ADMINISTRATIVE' AND expense_date BETWEEN $1 AND $2",[period.rows[0].period_start,period.rows[0].period_end]);
   const sums=new Map<string,number>();
   for(const item of p.data.allocations)sums.set(item.expenseId,(sums.get(item.expenseId)||0)+toMinorUnits(item.amount));
   for(const expense of expenses.rows){
    if(!hasCentPrecision(expense.amount))throw new AppError("EXPENSE_PRECISION_UNSUPPORTED","يوجد مصروف مسجل بأجزاء من القرش؛ صحح دقته بتسوية موثقة قبل التصفية",409);
    if((sums.get(expense.id)||0)!==toMinorUnits(expense.amount))throw new AppError("ALLOCATION_TOTAL_MISMATCH","يجب أن يساوي مجموع توزيع كل مصروف إداري قيمته الأصلية بدقة القرش",422);
   }
   if(p.data.allocations.some(a=>!expenses.rows.some(e=>e.id===a.expenseId)))throw new AppError("INVALID_ALLOCATION_EXPENSE","يوجد مصروف خارج الفترة أو ليس مصروفًا إداريًا",422);
   const validOrders=await client.query("SELECT id FROM production_orders WHERE status<>'CANCELLED'");
   const orderIds=new Set(validOrders.rows.map(r=>r.id));
   if(p.data.allocations.some(a=>!orderIds.has(a.orderId)))throw new AppError("INVALID_ALLOCATION_ORDER","يوجد اختيار طلبية غير صالح",422);
   const grouped=new Map<string,{expenseId:string;orderId:string;amount:number}>();
   for(const a of p.data.allocations){
    const key=a.expenseId+":"+a.orderId;
    const current=grouped.get(key);
    if(current)current.amount=Number((current.amount+a.amount).toFixed(4));
    else grouped.set(key,{expenseId:a.expenseId,orderId:a.orderId,amount:a.amount});
   }
   await client.query("DELETE FROM accounting_expense_allocations WHERE period_id=$1",[id]);
   let savedAllocationCount=0;
   for(const a of grouped.values()){
    if(toMinorUnits(a.amount)===0)continue;
    await client.query("INSERT INTO accounting_expense_allocations(period_id,expense_id,order_id,amount,created_by) VALUES($1,$2,$3,$4,$5)",[id,a.expenseId,a.orderId,a.amount,request.user!.userId]);
    savedAllocationCount++;
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"update_allocations",module:"finance",entityType:"accounting_period",entityId:id,afterData:{periodId:id,allocationCount:savedAllocationCount},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return {periodId:id,allocationCount:savedAllocationCount};
  })};
 });
 app.post("/api/accounting/periods/:id/submit-review",{preHandler:[authenticateRequest,requirePermission("finance.period_close.review")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_STATE_INVALID","لا يمكن إرسال الفترة للمراجعة إلا من حالة مفتوحة",409);
   const r=await client.query("UPDATE accounting_periods SET status='UNDER_REVIEW' WHERE id=$1 RETURNING *",[id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"submit_review",module:"finance",entityType:"accounting_period",entityId:id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  })};
 });
 app.post("/api/accounting/periods/:id/approve-review",{preHandler:[authenticateRequest,requirePermission("finance.period_close.review")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="UNDER_REVIEW")throw new AppError("ACCOUNTING_PERIOD_STATE_INVALID","الفترة ليست قيد المراجعة",409);
   const r=await client.query("UPDATE accounting_periods SET status='READY_FOR_APPROVAL',reviewed_by=$2,reviewed_at=now() WHERE id=$1 RETURNING *",[id,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"accounting_review_approved",module:"finance",entityType:"accounting_period",entityId:id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  })};
 });
 app.post("/api/accounting/periods/:id/close",{preHandler:[authenticateRequest,requirePermission("finance.period_close.approve")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="READY_FOR_APPROVAL")throw new AppError("ACCOUNTING_PERIOD_NOT_APPROVED","يجب اعتماد المراجعة المحاسبية قبل الإقفال النهائي",409);
   if(period.rows[0].reviewed_by===request.user!.userId)throw new AppError("SEPARATION_OF_DUTIES_REQUIRED","يجب أن يكون اعتماد الإقفال النهائي بواسطة مستخدم مختلف عن مراجع الفترة",409);
   const expenses=await client.query("SELECT e.id,e.amount,COALESCE(SUM(a.amount),0) AS allocated FROM accounting_expense_allocations a RIGHT JOIN accounting_expenses e ON e.id=a.expense_id AND a.period_id=$3 WHERE e.expense_type='ADMINISTRATIVE' AND e.expense_date BETWEEN $1 AND $2 GROUP BY e.id,e.amount",[period.rows[0].period_start,period.rows[0].period_end,id]);
   if(expenses.rows.some(e=>!hasCentPrecision(e.amount)))throw new AppError("EXPENSE_PRECISION_UNSUPPORTED","يوجد مصروف مسجل بأجزاء من القرش؛ صحح دقته بتسوية موثقة قبل الإقفال",409);
   const unbalanced=expenses.rows.filter(e=>toMinorUnits(e.amount)!==toMinorUnits(e.allocated));
   if(unbalanced.length)throw new AppError("UNALLOCATED_ADMIN_EXPENSES","لا يمكن قفل الفترة قبل توزيع كامل المصروفات الإدارية على الطلبيات",409);
   const start=period.rows[0].period_start,end=period.rows[0].period_end;
   const [cash,workerDues,advances,inventory,revenue,expense,pending]=await Promise.all([
    client.query("SELECT e.id AS employee_id,e.code,e.full_name,COALESCE(SUM(CASE WHEN c.direction='IN' THEN c.amount ELSE -c.amount END),0) AS balance FROM employees e LEFT JOIN cash_custody_transactions c ON c.employee_id=e.id AND c.transaction_date<=$1::date GROUP BY e.id,e.code,e.full_name ORDER BY e.code",[end]),
    client.query("SELECT e.id AS employee_id,e.code,e.full_name,COALESCE(SUM(l.credit_amount-l.debit_amount),0) AS balance FROM employees e LEFT JOIN employee_earnings_ledger l ON l.employee_id=e.id AND l.created_at::date<=$1::date GROUP BY e.id,e.code,e.full_name ORDER BY e.code",[end]),
    client.query("SELECT a.id,a.code,a.employee_id,e.code AS employee_code,e.full_name,a.amount,GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id AND ar.payment_date<=$1::date),0),0) AS remaining FROM advance_requests a JOIN employees e ON e.id=a.employee_id WHERE a.status='PAID' AND a.paid_at::date<=$1::date ORDER BY e.code,a.code",[end]),
    client.query("SELECT sm.product_id,sm.warehouse_id,sm.location_id,COALESCE(SUM(CASE WHEN sm.movement_type IN ('IN','RETURN','TRANSFER_IN') OR (sm.movement_type='ADJUSTMENT' AND sm.reference_type IS DISTINCT FROM 'ADJUSTMENT_OUT') THEN sm.quantity ELSE -sm.quantity END),0) AS quantity,COALESCE(SUM(CASE WHEN sm.movement_type IN ('IN','RETURN','TRANSFER_IN') OR (sm.movement_type='ADJUSTMENT' AND sm.reference_type IS DISTINCT FROM 'ADJUSTMENT_OUT') THEN sm.total_cost ELSE -sm.total_cost END),0) AS inventory_value FROM stock_movements sm WHERE sm.created_at::date<=$1::date GROUP BY sm.product_id,sm.warehouse_id,sm.location_id HAVING ABS(COALESCE(SUM(CASE WHEN sm.movement_type IN ('IN','RETURN','TRANSFER_IN') OR (sm.movement_type='ADJUSTMENT' AND sm.reference_type IS DISTINCT FROM 'ADJUSTMENT_OUT') THEN sm.quantity ELSE -sm.quantity END),0))>0.000001 ORDER BY sm.product_id,sm.warehouse_id,sm.location_id",[end]),
    client.query("SELECT COALESCE(SUM(amount),0) AS total FROM order_revenues WHERE revenue_date BETWEEN $1::date AND $2::date AND UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'",[start,end]),
    client.query("SELECT COALESCE(SUM(amount),0) AS total FROM accounting_expenses WHERE expense_date BETWEEN $1::date AND $2::date",[start,end]),
    client.query("SELECT (SELECT COUNT(*)::int FROM advance_requests WHERE status IN ('PENDING','APPROVED') AND created_at::date<=$1::date) AS pending_advances,(SELECT COUNT(*)::int FROM payroll_items pi JOIN payroll_periods pp ON pp.id=pi.period_id WHERE pi.status<>'PAID' AND pp.period_month<=$1::date) AS unpaid_payroll_items,(SELECT COUNT(*)::int FROM production_orders WHERE status IN ('DRAFT','PLANNED','IN_PROGRESS')) AS open_production_orders",[end])
   ]);
   const report={period:{id,name:period.rows[0].name,start,end},generatedAt:new Date().toISOString(),totals:{revenue:Number(revenue.rows[0].total),expenses:Number(expense.rows[0].total)},cashCustody:cash.rows,workerDues:workerDues.rows,advances:advances.rows,inventory:inventory.rows,pending:pending.rows[0]};
   const reportJson=JSON.stringify(report);
   const reportHash=createHash("sha256").update(reportJson).digest("hex");
   const snapshotVersion=await client.query("SELECT COALESCE(MAX(snapshot_no),0)+1 AS next_version FROM accounting_period_close_snapshots WHERE period_id=$1",[id]);
   await client.query("INSERT INTO accounting_period_close_snapshots(period_id,snapshot_no,report,report_sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5)",[id,snapshotVersion.rows[0].next_version,reportJson,reportHash,request.user!.userId]);
   const r=await client.query("UPDATE accounting_periods SET status='CLOSED',closed_by=$2,closed_at=now(),approved_by=$2,approved_at=now() WHERE id=$1 RETURNING *",[id,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"close",module:"finance",entityType:"accounting_period",entityId:id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  })};
 });



 app.get("/api/accounting/periods/:id/report",{preHandler:[authenticateRequest,requirePermission("finance.period_close.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const r=await pool.query("SELECT p.id AS period_id,p.name,p.period_start,p.period_end,p.status,s.snapshot_no,s.report,s.report_sha256,s.created_by,s.created_at FROM accounting_periods p JOIN LATERAL (SELECT * FROM accounting_period_close_snapshots WHERE period_id=p.id ORDER BY snapshot_no DESC LIMIT 1) s ON TRUE WHERE p.id=$1",[id]);
  if(!r.rowCount)throw new AppError("ACCOUNTING_PERIOD_REPORT_NOT_FOUND","لا يوجد تقرير إقفال محفوظ لهذه الفترة",404);
  return {data:r.rows[0]};
 });

 app.post("/api/accounting/periods/:id/reopen",{preHandler:[authenticateRequest,requirePermission("finance.period_close.reopen")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const p=z.object({reason:z.string().trim().min(10).max(1000)}).safeParse(request.body);
  if(!p.success)throw new AppError("REOPEN_REASON_REQUIRED","يجب كتابة سبب واضح لإعادة فتح الفترة (10 أحرف على الأقل)",422);
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="CLOSED")throw new AppError("ACCOUNTING_PERIOD_NOT_CLOSED","يمكن إعادة فتح فترة مقفولة فقط",409);
   const carried=await client.query("SELECT 1 FROM accounting_period_opening_balances WHERE source_period_id=$1 LIMIT 1",[id]);
   if(carried.rowCount)throw new AppError("PERIOD_ALREADY_CARRIED_FORWARD","لا يمكن إعادة فتح الفترة بعد ترحيل أرصدتها؛ يلزم إجراء تصحيح محاسبي مستقل للفترة اللاحقة",409);
   const before=period.rows[0];
   const r=await client.query("UPDATE accounting_periods SET status='OPEN',closed_by=NULL,closed_at=NULL,reviewed_by=NULL,reviewed_at=NULL,approved_by=NULL,approved_at=NULL,reopened_by=$2,reopened_at=now(),reopen_reason=$3 WHERE id=$1 RETURNING *",[id,request.user!.userId,p.data.reason]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reopen",module:"finance",entityType:"accounting_period",entityId:id,beforeData:before,afterData:{...r.rows[0],reopenReason:p.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  })};
 });


 app.get("/api/accounting/orders-dashboard",{preHandler:[authenticateRequest,requirePermission("finance.profitability.view")]},async(request)=>{
  const q=z.object({status:z.enum(["DRAFT","PLANNED","IN_PROGRESS","COMPLETED","CANCELLED"]).optional(),periodId:z.string().uuid().optional()}).safeParse(request.query);
  if(!q.success)throw new AppError("VALIDATION_ERROR","فلتر الحالة أو الفترة المالية غير صحيح",422);
  let periodStart:string|null=null;let periodEnd:string|null=null;
  if(q.data.periodId){
    const period=await pool.query("SELECT id,period_start,period_end,status FROM accounting_periods WHERE id=$1",[q.data.periodId]);
    if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
    if(period.rows[0].status!=="CLOSED")throw new AppError("ACCOUNTING_PERIOD_NOT_CLOSED","اختَر فترة مالية مقفولة لعرض تقريرها المعتمد",409);
    periodStart=period.rows[0].period_start;periodEnd=period.rows[0].period_end;
  }
  const params=[periodStart,periodEnd,q.data.status??null,q.data.periodId??null];
  const result=await pool.query(`SELECT o.id,o.code,o.order_name,o.customer_name,o.status,o.order_date,o.due_date,o.contract_value,
    COALESCE(o.contract_value,0) AS accrued_revenue,
    COALESCE((SELECT SUM(r.amount) FROM order_revenues r WHERE r.order_id=o.id AND UPPER(r.source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP' AND ($1::date IS NULL OR r.revenue_date BETWEEN $1::date AND $2::date)),0) AS revenue,
    COALESCE((SELECT SUM(e.amount) FROM accounting_expenses e WHERE e.order_id=o.id AND e.expense_type='DIRECT' AND ($1::date IS NULL OR e.expense_date BETWEEN $1::date AND $2::date)),0) AS direct_expenses,
    COALESCE((SELECT SUM(a.amount) FROM accounting_expense_allocations a JOIN accounting_periods ap ON ap.id=a.period_id WHERE a.order_id=o.id AND ap.status='CLOSED' AND ($4::uuid IS NULL OR a.period_id=$4::uuid)),0) AS administrative_allocation,
    COALESCE((SELECT SUM(sm.total_cost) FROM stock_movements sm WHERE sm.order_id=o.id AND sm.movement_type='OUT' AND sm.reference_type IS DISTINCT FROM 'DELIVERY' AND ($1::date IS NULL OR sm.created_at::date BETWEEN $1::date AND $2::date)),0) AS material_cost,
    COALESCE((SELECT SUM(COALESCE(pe.total_earning_amount,pe.earning_amount)) FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=o.id AND pe.status='APPROVED' AND ($1::date IS NULL OR pe.work_date BETWEEN $1::date AND $2::date)),0)
    +COALESCE((SELECT SUM(pci.delta_amount) FROM order_price_change_items pci JOIN order_price_changes pc ON pc.id=pci.price_change_id JOIN production_entries pe ON pe.id=pci.production_entry_id JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=o.id AND pe.status='APPROVED' AND pci.ledger_adjustment=TRUE AND ($1::date IS NULL OR pc.created_at::date BETWEEN $1::date AND $2::date)),0) AS labor_cost
    FROM production_orders o WHERE ($3::text IS NULL OR o.status=$3::text) ORDER BY o.created_at DESC`,params);
  const data=result.rows.map(row=>{
   const revenue=Number(row.revenue||0),direct=Number(row.direct_expenses||0),admin=Number(row.administrative_allocation||0),material=Number(row.material_cost||0),labor=Number(row.labor_cost||0);
   const totalCost=direct+admin+material+labor;
   const accruedRevenue=Number(row.accrued_revenue??row.contract_value??0);
   return {...row,revenue,accrued_revenue:accruedRevenue,direct_expenses:direct,administrative_allocation:admin,material_cost:material,labor_cost:labor,total_cost:totalCost,profit:revenue-totalCost,accrued_profit:accruedRevenue-totalCost,margin_percent:revenue>0?((revenue-totalCost)/revenue)*100:null,accrued_margin_percent:accruedRevenue>0?((accruedRevenue-totalCost)/accruedRevenue)*100:null};
  });
  return {data,summary:{orders:data.length,revenue:data.reduce((s,r)=>s+r.revenue,0),cost:data.reduce((s,r)=>s+r.total_cost,0),profit:data.reduce((s,r)=>s+r.profit,0)}};
 });

 app.get("/api/accounting/orders/:orderId/profitability",{preHandler:[authenticateRequest,requirePermission("finance.profitability.view")]},async(request)=>{
  const p=idSchema.safeParse(request.params);if(!p.success)throw new AppError("VALIDATION_ERROR","الطلبية غير صحيحة",422);
  const order=await pool.query("SELECT id,code,order_name,status,customer_name,COALESCE(contract_value,0) AS accrued_revenue FROM production_orders WHERE id=$1",[p.data.orderId]);if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
  const [revenue,expenses,stockOut,labor]=await Promise.all([
   pool.query("SELECT COALESCE(SUM(amount),0) AS value FROM order_revenues WHERE order_id=$1 AND UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'",[p.data.orderId]),
   pool.query(`SELECT
     COALESCE((SELECT SUM(amount) FROM accounting_expenses WHERE order_id=$1 AND expense_type='DIRECT'),0) AS value,
     COALESCE((SELECT SUM(a.amount) FROM accounting_expense_allocations a JOIN accounting_periods ap ON ap.id=a.period_id WHERE a.order_id=$1 AND ap.status='CLOSED'),0) AS administrative_allocation`,[p.data.orderId]),
   pool.query("SELECT COALESCE(SUM(total_cost),0) AS value FROM stock_movements WHERE order_id=$1 AND movement_type='OUT' AND reference_type IS DISTINCT FROM 'DELIVERY'",[p.data.orderId]),
   pool.query("SELECT COALESCE((SELECT SUM(COALESCE(pe.total_earning_amount,pe.earning_amount)) FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status='APPROVED'),0)+COALESCE((SELECT SUM(pci.delta_amount) FROM order_price_change_items pci JOIN production_entries pe ON pe.id=pci.production_entry_id JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status='APPROVED' AND pci.ledger_adjustment=TRUE),0) AS value",[p.data.orderId])
  ]);
  const revenueValue=Number(revenue.rows[0].value||0);
  const explicitExpenses=Number(expenses.rows[0].value||0);
  const administrativeAllocation=Number(expenses.rows[0].administrative_allocation||0);
  const materialValue=Number(stockOut.rows[0].value||0);
  const laborValue=Number(labor.rows[0].value||0);
  const totalCost=explicitExpenses+administrativeAllocation+materialValue+laborValue;
  const accruedRevenue=Number(order.rows[0].accrued_revenue||0);
  return {data:{order:order.rows[0],accruedRevenue,revenue:revenueValue,expenses:explicitExpenses,administrativeAllocation,materialCost:materialValue,laborCost:laborValue,totalCost,profit:revenueValue-totalCost,marginPercent:revenueValue>0?((revenueValue-totalCost)/revenueValue)*100:null}};
 });
}
