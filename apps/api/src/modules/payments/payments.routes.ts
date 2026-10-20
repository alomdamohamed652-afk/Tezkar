import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";
import { hasPermission } from "../rbac/rbac.service.js";

const requestSchema = z.object({
  amount: z.number().positive(),
  method: z.string().trim().min(1).max(50),
  transferReference: z.string().trim().min(3).max(120).nullable().optional()
}).superRefine((value, ctx) => {
  if (["VODAFONE_CASH", "INSTAPAY", "BANK"].includes(value.method) && !value.transferReference?.trim()) {
    ctx.addIssue({ code: "custom", path: ["transferReference"], message: "رقم التحويل أو الحساب مطلوب لطريقة القبض المختارة" });
  }
});
const paymentMethodSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,50}$/),
  name: z.string().trim().min(2).max(100),
  sortOrder: z.number().int().min(0).max(9999).default(0)
});

const rejectSchema = z.object({ reason: z.string().trim().min(2).max(500) });

function isUniqueViolation(error: unknown): boolean {
  const code=typeof error==="object"&&error!==null&&"code" in error?(error as {code?:unknown}).code:null;
  return code==="23505";
}

async function isWorker(userId:string) {
  const r=await pool.query(
    `SELECT u.employee_id, EXISTS(
       SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
       WHERE ur.user_id=$1 AND r.code='worker' AND r.is_active=TRUE
     ) AS is_worker
     FROM users u WHERE u.id=$1`,[userId]);
  return r.rows[0] ?? null;
}

async function lockEmployee(client: import("pg").PoolClient, employeeId:string) {
  const r=await client.query(
    "SELECT id FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",
    [employeeId]
  );
  if (!r.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 409);
}

async function getBalance(client: import("pg").PoolClient, employeeId:string) {
  const r=await client.query(
    `SELECT COALESCE(SUM(credit_amount - debit_amount),0) AS balance
       FROM employee_earnings_ledger
      WHERE employee_id=$1`,
    [employeeId]
  );
  return Number(r.rows[0]?.balance ?? 0);
}

async function getAvailableEarnings(client:import("pg").PoolClient,employeeId:string) {
  // Gross approved earnings less unified settlements and legacy payments that predate settlement links.
  const totals=await client.query(`
    SELECT COUNT(*) FILTER(WHERE pe.status='APPROVED')::int AS approved_count,
      COALESCE(SUM(COALESCE(pe.total_earning_amount,pe.earning_amount)) FILTER(WHERE pe.status='APPROVED'),0) AS production_earned,
      COALESCE((SELECT SUM(CASE WHEN a.adjustment_type='BONUS' THEN a.amount ELSE -a.amount END)
        FROM employee_earnings_adjustments a LEFT JOIN production_entries p ON p.id=a.production_entry_id
        WHERE a.employee_id=$1 AND a.production_entry_id IS NULL),0) AS adjustments,
      COALESCE((SELECT SUM(s.gross_amount) FROM employee_earnings_settlements s WHERE s.employee_id=$1),0) AS settled,
      COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
        LEFT JOIN employee_earnings_settlements s ON s.worker_payment_id=wp.id
        WHERE wp.employee_id=$1 AND s.id IS NULL),0) AS legacy_paid
    FROM production_entries pe WHERE pe.employee_id=$1
  `,[employeeId]);
  if(Number(totals.rows[0]?.approved_count??0)>0) {
    const available=Number(totals.rows[0].production_earned)+Number(totals.rows[0].adjustments)
      -Number(totals.rows[0].settled)-Number(totals.rows[0].legacy_paid);
    return Math.max(0,Math.round(available*100)/100);
  }
  // Imported ledger-only balances remain supported where no approved production rows exist.
  const balance=await getBalance(client,employeeId);
  const outstanding=await getOutstandingAdvanceAmount(client,employeeId);
  return Math.max(0,Math.round((balance+outstanding)*100)/100);
}
async function getOutstandingAdvanceAmount(client:import("pg").PoolClient,employeeId:string) {
  const r=await client.query(`
    SELECT COALESCE(SUM(GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0)),0) AS outstanding
      FROM advance_requests a WHERE a.employee_id=$1 AND a.status='PAID' AND a.repayment_status='OPEN'
  `,[employeeId]);
  return Number(r.rows[0]?.outstanding??0);
}

type PlannedAdvanceRepayment={advance:any;amount:number;repaymentType:"CUSTOM"|"PRODUCTION_PERCENTAGE"};

async function planAdvanceRepayments(client:import("pg").PoolClient,employeeId:string,grossAmount:number,manualAmount:number,paymentDate:string) {
  const advances=await client.query(`
    SELECT a.*,
      GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0) AS outstanding,
      (SELECT MAX(ar.payment_date) FROM advance_repayments ar WHERE ar.advance_id=a.id) AS last_repayment_date
    FROM advance_requests a
    WHERE a.employee_id=$1 AND a.status='PAID' AND a.repayment_status='OPEN'
    ORDER BY a.paid_at,a.created_at,a.id FOR UPDATE
  `,[employeeId]);
  const plan:PlannedAdvanceRepayment[]=[];
  let remainingGross=Math.max(0,Math.round(grossAmount*100)/100);
  const scheduledDue=await getDueProductionAdvanceRepayment(client,employeeId,paymentDate);
  const dueByAdvance=new Map(scheduledDue.items.map(item=>[item.advanceId,item.amount]));
  for(const advance of advances.rows){
    if(remainingGross<=0.01)break;
    if(advance.repayment_method!=="PRODUCTION_PERCENTAGE")continue;
    const dueAmount=dueByAdvance.get(advance.id)??0;
    const amount=Math.round(Math.min(Number(advance.outstanding),dueAmount,Math.max(0,remainingGross-0.01))*100)/100;
    if(amount<=0)continue;
    plan.push({advance,amount,repaymentType:"PRODUCTION_PERCENTAGE"});
    remainingGross=Math.round((remainingGross-amount)*100)/100;
  }
  if(manualAmount>remainingGross+0.009)throw new AppError("REPAYMENT_EXCEEDS_GROSS","مبلغ الخصم اليدوي أكبر من صافي المستحق بعد الاستقطاع الدوري",422);
  let manualRemaining=Math.round(manualAmount*100)/100;
  for(const advance of advances.rows){
    if(manualRemaining<=0)break;
    const planned=plan.find(x=>x.advance.id===advance.id);
    const availableForAdvance=Math.max(0,Number(advance.outstanding)-(planned?.amount??0));
    if(availableForAdvance<=0)continue;
    const amount=Math.round(Math.min(availableForAdvance,manualRemaining,Math.max(0,remainingGross-0.01))*100)/100;
    if(amount<=0)continue;
    if(planned){planned.amount=Math.round((planned.amount+amount)*100)/100;planned.repaymentType="CUSTOM";}
    else plan.push({advance,amount,repaymentType:"CUSTOM"});
    manualRemaining=Math.round((manualRemaining-amount)*100)/100;
    remainingGross=Math.round((remainingGross-amount)*100)/100;
  }
  if(manualRemaining>0.009)throw new AppError("REPAYMENT_EXCEEDS_ADVANCES","مبلغ الخصم اليدوي أكبر من إجمالي السلف المفتوحة",422);
  const total=Math.round(plan.reduce((sum,x)=>sum+x.amount,0)*100)/100;
  if(total>=grossAmount)throw new AppError("NO_NET_PAYOUT","الخصم سيستهلك كامل المستحق؛ سجّل سداد السلفة منفصلًا بدل سند قبض بصافي صفر",422);
  return {plan,total,cashPaid:Math.round((grossAmount-total)*100)/100};
}

async function getDueProductionAdvanceRepayment(client:import("pg").PoolClient,employeeId:string,paymentDate:string){
  const advances=await client.query(`
    SELECT a.*,
      GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0) AS outstanding,
      (SELECT MAX(ar.payment_date) FROM advance_repayments ar WHERE ar.advance_id=a.id) AS last_repayment_date
    FROM advance_requests a
    WHERE a.employee_id=$1 AND a.status='PAID' AND a.repayment_status='OPEN'
      AND a.repayment_method='PRODUCTION_PERCENTAGE'
    ORDER BY a.paid_at,a.created_at,a.id
  `,[employeeId]);
  const items:Array<{advanceId:string;advanceCode:string;amount:number;periodDays:number;duePeriods:number}>=[];
  for(const advance of advances.rows){
    const startValue=advance.last_repayment_date??advance.paid_at;
    const startDate=startValue instanceof Date?startValue.toISOString().slice(0,10):String(startValue).slice(0,10);
    const elapsed=Math.floor((Date.parse(paymentDate+"T00:00:00Z")-Date.parse(startDate+"T00:00:00Z"))/86400000);
    const periodDays=Number(advance.production_period_days??15);
    if(elapsed<periodDays)continue;
    const duePeriods=Math.max(1,Math.floor(elapsed/periodDays));
    const production=await client.query(
      `SELECT GREATEST(0,
          COALESCE(SUM(COALESCE(pe.total_earning_amount,pe.earning_amount)),0)
          -COALESCE((SELECT SUM(s.gross_amount) FROM employee_earnings_settlements s WHERE s.employee_id=$1 AND s.settlement_date>$2::date AND s.settlement_date<=$3::date),0)
          -COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
                      LEFT JOIN employee_earnings_settlements s ON s.worker_payment_id=wp.id
                     WHERE wp.employee_id=$1 AND s.id IS NULL AND wp.created_at::date>$2::date AND wp.created_at::date<=$3::date),0)
        ) AS amount
         FROM production_entries pe WHERE pe.employee_id=$1 AND pe.status='APPROVED' AND pe.work_date>$2::date AND pe.work_date<=$3::date`,
      [employeeId,startDate,paymentDate]
    );
    const periodEarning=Number(production.rows[0].amount);
    if(advance.production_minimum_earning!==null&&advance.production_minimum_earning!==undefined&&periodEarning<Number(advance.production_minimum_earning))continue;
    const scheduled=advance.production_installment_amount!==null
      ?Number(advance.production_installment_amount)*duePeriods
      :periodEarning*Number(advance.production_percentage??0)/100;
    const amount=Math.round(Math.min(Number(advance.outstanding),scheduled)*100)/100;
    if(amount>0)items.push({advanceId:advance.id,advanceCode:advance.code,amount,periodDays,duePeriods});
  }
  return {total:Math.round(items.reduce((sum,x)=>sum+x.amount,0)*100)/100,items};
}

async function recordCashCustodyOut(client:import("pg").PoolClient,userId:string,custodyEmployeeId:string,netAmount:number,requestCode:string,paymentId:string,grossAmount=netAmount,repaymentAmount=0){
  const canAll=await hasPermission(client,userId,"cash_custody.worker_payment_out","all");
  const canOwn=await hasPermission(client,userId,"cash_custody.worker_payment_out_own","own");
  if(!canAll&&!canOwn)throw new AppError("CASH_CUSTODY_PERMISSION_REQUIRED","يلزم منح صلاحية مستقلة لخصم صرف العامل من العهدة النقدية",403);
  if(!canAll){
    const owner=await client.query("SELECT employee_id FROM users WHERE id=$1",[userId]);
    if(!canOwn||owner.rows[0]?.employee_id!==custodyEmployeeId)throw new AppError("CASH_CUSTODY_SCOPE_DENIED","يمكنك الخصم من عهدتك النقدية فقط",403);
  }
  await lockEmployee(client,custodyEmployeeId);
  const existing=await client.query("SELECT id FROM cash_custody_transactions WHERE source_type='WORKER_PAYMENT' AND source_id=$1 LIMIT 1",[paymentId]);
  if(existing.rowCount)return existing.rows[0];
  const balance=await client.query("SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1 AND transaction_date<=CURRENT_DATE",[custodyEmployeeId]);
  if(netAmount>Number(balance.rows[0]?.balance??0)+1e-9)throw new AppError("INSUFFICIENT_CASH_CUSTODY_BALANCE","رصيد العهدة النقدية لا يكفي لصافي المبلغ المدفوع للعامل. تم إيقاف العملية دون ترحيل أي جزء منها.",409);
  // Custody movements must reflect physical cash only: the custodian pays the net amount.
  // Advance repayment is an internal payroll offset, not cash received back into the custody.
  const row=await client.query(
    "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'OUT',$2,CURRENT_DATE,$3,$4,'WORKER_PAYMENT',$5,$6) RETURNING *",
    [custodyEmployeeId,netAmount,"صرف مستحقات العامل "+requestCode,repaymentAmount>0?`إجمالي المستحق ${grossAmount.toFixed(2)} ج.م؛ صافي النقد المصروف ${netAmount.toFixed(2)} ج.م؛ تسوية سلف ${repaymentAmount.toFixed(2)} ج.م`:"صرف مستحقات العامل بالقيمة كاملة. رقم السند: "+paymentId,paymentId,userId]
  );
  return row.rows[0];
}

async function executeWorkerPayment(
  client:import("pg").PoolClient,
  input:{userId:string;actorEmployeeId:string|null;ipAddress:string|null;userAgent:string|null;custodyEmployeeId:string;employeeId:string;requestId:string|null;requestCode:string;grossAmount:number;method:string;transferReference:string|null;manualRepaymentAmount:number;idempotencyKey?:string|null;idempotencyFingerprint?:string|null;skipCashCustodyOut?:boolean}
){
  const available=await getAvailableEarnings(client,input.employeeId);
  if(input.grossAmount>available+0.009)throw new AppError("INSUFFICIENT_BALANCE",`مستحقات الإنتاج المتاحة ${available.toFixed(2)} ج.م فقط`,409);
  const paymentDate=new Date().toISOString().slice(0,10);
  const planned=await planAdvanceRepayments(client,input.employeeId,input.grossAmount,input.manualRepaymentAmount,paymentDate);
  const payment=await client.query(
    `INSERT INTO worker_payments(employee_id,amount,gross_amount,advance_repayment_amount,method,payment_request_id,paid_by,notes,transfer_reference,idempotency_key,idempotency_fingerprint)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [input.employeeId,planned.cashPaid,input.grossAmount,planned.total,input.method,input.requestId,input.userId,
      planned.total>0?`إجمالي المستحق ${input.grossAmount.toFixed(2)} ج.م؛ استرداد سلف ${planned.total.toFixed(2)} ج.م؛ صافي المدفوع ${planned.cashPaid.toFixed(2)} ج.م`:null,
      input.transferReference,input.idempotencyKey??null,input.idempotencyFingerprint??null]);
  const settlement=await client.query(
    `INSERT INTO employee_earnings_settlements(employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,worker_payment_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [input.employeeId,input.grossAmount,planned.cashPaid,planned.total,paymentDate,`تسوية طلب قبض ${input.requestCode}`,input.userId,payment.rows[0].id]);
  for(const item of planned.plan){
    const repayment=await client.query(
      `INSERT INTO advance_repayments(advance_id,amount,repayment_type,payment_date,notes,created_by,source_worker_payment_id,settlement_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [item.advance.id,item.amount,item.repaymentType,paymentDate,
       `سداد سلفة ${item.advance.code} من طلب قبض ${input.requestCode}`,input.userId,payment.rows[0].id,settlement.rows[0].id]);
    await client.query(
      `INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,advance_repayment_id,created_by,notes)
       VALUES($1,'ADJUSTMENT',$2,$3,$4,$5)
       ON CONFLICT (advance_repayment_id) WHERE advance_repayment_id IS NOT NULL DO NOTHING`,
      [input.employeeId,item.amount,repayment.rows[0].id,input.userId,`سداد سلفة ${item.advance.code} من مستحقات طلب قبض ${input.requestCode}`]);
    const next=Number(item.advance.outstanding)-item.amount;
    await client.query("UPDATE advance_requests SET repayment_status=$1,updated_at=now() WHERE id=$2",[next<=0.009?"SETTLED":"OPEN",item.advance.id]);
    await writeAudit(client,{actorUserId:input.userId,actorEmployeeId:input.actorEmployeeId,action:"worker_payment_advance_repayment",module:"advances",entityType:"advance_request",entityId:item.advance.id,metadata:{workerPaymentId:payment.rows[0].id,requestId:input.requestId,amount:item.amount,remaining:Math.max(0,next)},ipAddress:input.ipAddress,userAgent:input.userAgent});
  }
  await client.query(
    `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,worker_payment_id,settlement_id,created_by,notes)
     VALUES($1,'WORKER_PAYMENT',$2,$3,$4,$5,$6)
     ON CONFLICT (worker_payment_id) WHERE worker_payment_id IS NOT NULL DO NOTHING`,
    [input.employeeId,input.grossAmount,payment.rows[0].id,settlement.rows[0].id,input.userId,
      planned.total>0?`تسوية إجمالي مستحقات طلب قبض ${input.requestCode}؛ سداد سلف ${planned.total.toFixed(2)} ج.م؛ صافي نقد مدفوع ${planned.cashPaid.toFixed(2)} ج.م`:`تسوية إجمالي مستحقات طلب قبض ${input.requestCode}`]);
  if(!input.skipCashCustodyOut) await recordCashCustodyOut(client,input.userId,input.custodyEmployeeId,planned.cashPaid,input.requestCode,payment.rows[0].id,input.grossAmount,planned.total);

  let allocationRemaining=input.grossAmount;
  const productions=await client.query(
    `SELECT pe.id,
      GREATEST(0,COALESCE(pe.total_earning_amount,pe.earning_amount)-
        COALESCE((SELECT SUM(wpa.amount) FROM worker_payment_allocations wpa WHERE wpa.production_entry_id=pe.id),0)) AS remaining
      FROM production_entries pe
     WHERE pe.employee_id=$1 AND pe.status='APPROVED'
     ORDER BY pe.work_date ASC,pe.created_at ASC,pe.id ASC FOR UPDATE`,
    [input.employeeId]);
  for(const production of productions.rows){
    if(allocationRemaining<=0.000001)break;
    const take=Math.min(allocationRemaining,Number(production.remaining));
    if(take<=0.000001)continue;
    await client.query(
      `INSERT INTO worker_payment_allocations(worker_payment_id,production_entry_id,amount)
       VALUES($1,$2,$3) ON CONFLICT(worker_payment_id,production_entry_id)
       DO UPDATE SET amount=worker_payment_allocations.amount+EXCLUDED.amount`,
      [payment.rows[0].id,production.id,take]);
    allocationRemaining-=take;
  }
  return {payment:payment.rows[0],grossAmount:input.grossAmount,advanceRepaymentAmount:planned.total,cashPaid:planned.cashPaid,repayments:planned.plan.map(x=>({advanceCode:x.advance.code,amount:x.amount,remaining:Math.max(0,Number(x.advance.outstanding)-x.amount)}))};
}

export async function paymentsRoutes(app:FastifyInstance){
  app.get("/api/payment-methods",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.view")]
  },async()=>{
    const r=await pool.query("SELECT code,name,is_active,sort_order FROM payment_methods WHERE is_active=TRUE ORDER BY sort_order,name");
    return {data:r.rows};
  });

  app.post("/api/payment-methods",{
    preHandler:[authenticateRequest,requirePermission("payment_methods.manage")]
  },async(request,reply)=>{
    const parsed=paymentMethodSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات طريقة القبض غير صحيحة",422);
    const r=await pool.query("INSERT INTO payment_methods(code,name,sort_order) VALUES($1,$2,$3) RETURNING *",[parsed.data.code,parsed.data.name,parsed.data.sortOrder]);
    return reply.code(201).send({data:r.rows[0]});
  });
  app.get("/api/payment-requests",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.view")]
  },async(request)=>{
    const q=z.object({status:z.enum(["PENDING","APPROVED","REJECTED","CANCELLED","PAID"]).optional()}).safeParse(request.query);
    if(!q.success) throw new AppError("VALIDATION_ERROR","الفلاتر غير صحيحة",422);
    const user=await isWorker(request.user!.userId);
    const params:unknown[]=[]; const where:string[]=[];
    if(user?.is_worker){
      if(!user.employee_id) throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
      params.push(user.employee_id); where.push(`pr.employee_id=$${params.length}`);
    }
    if(q.data.status){params.push(q.data.status);where.push(`pr.status=$${params.length}`);}
    const r=await pool.query(
      `SELECT pr.*,e.code employee_code,e.full_name employee_name,
         COALESCE((SELECT SUM(GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0))
           FROM advance_requests a WHERE a.employee_id=pr.employee_id AND a.status='PAID' AND a.repayment_status='OPEN'),0) AS outstanding_advance_amount,
         wp.amount AS net_paid_amount,wp.gross_amount AS gross_paid_amount,wp.advance_repayment_amount
       FROM payment_requests pr JOIN employees e ON e.id=pr.employee_id
       LEFT JOIN worker_payments wp ON wp.id=pr.paid_payment_id
       ${where.length?"WHERE "+where.join(" AND "):""}
       ORDER BY pr.requested_at DESC LIMIT 200`,params);
    const paymentDate=new Date().toISOString().slice(0,10);
    const dueByEmployee=new Map<string,number>();
    const client=await pool.connect();
    try{
      for(const row of r.rows){
        if(row.status!=="PENDING"&&row.status!=="APPROVED")continue;
        if(dueByEmployee.has(row.employee_id))continue;
        const due=await getDueProductionAdvanceRepayment(client,row.employee_id,paymentDate);
        dueByEmployee.set(row.employee_id,due.total);
      }
    }finally{client.release();}
    return {data:r.rows.map(row=>({...row,due_advance_repayment_amount:dueByEmployee.get(row.employee_id)??0}))};
  });

  app.get("/api/payments/my-balance",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.view")]
  },async(request)=>{
    const user=await isWorker(request.user!.userId);
    if(!user?.employee_id) throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
    const client=await pool.connect();
    try{
      const due=await getDueProductionAdvanceRepayment(client,user.employee_id,new Date().toISOString().slice(0,10));
      return {data:{
        balance:await getBalance(client,user.employee_id),
        availableEarnings:await getAvailableEarnings(client,user.employee_id),
        outstandingAdvanceAmount:await getOutstandingAdvanceAmount(client,user.employee_id),
        dueAdvanceRepaymentAmount:due.total,
        dueAdvanceRepayments:due.items
      }};
    }finally{client.release();}
  });

  app.post("/api/payment-requests",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.create", "own")]
  },async(request,reply)=>{
    const parsed=requestSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات طلب القبض غير صحيحة",422);
    const method=await pool.query("SELECT code FROM payment_methods WHERE code=$1 AND is_active=TRUE",[parsed.data.method]);
    if(!method.rowCount) throw new AppError("PAYMENT_METHOD_NOT_FOUND","طريقة القبض غير متاحة",422);

    const user=await isWorker(request.user!.userId);
    if(!user?.is_worker || !user.employee_id) throw new AppError("WORKER_ONLY","طلب القبض متاح للعامل فقط",403);

    let row;
    try {
      row=await withTransaction(async(client)=>{
      await lockEmployee(client,user.employee_id);
      const available=await getAvailableEarnings(client,user.employee_id);
      if(parsed.data.amount>available+0.009) throw new AppError("INSUFFICIENT_BALANCE",`المبلغ المطلوب أكبر من مستحقات الإنتاج غير المصروفة (${available.toFixed(2)} ج.م)`,409);
      const open=await client.query(
        "SELECT id FROM payment_requests WHERE employee_id=$1 AND status IN ('PENDING','APPROVED') LIMIT 1 FOR UPDATE",
        [user.employee_id]);
      if(open.rowCount) throw new AppError("OPEN_REQUEST_EXISTS","يوجد طلب قبض مفتوح بالفعل",409);

      const inserted=await client.query(
        `INSERT INTO payment_requests(employee_id,amount,method,transfer_reference,requested_by)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [user.employee_id,parsed.data.amount,parsed.data.method,parsed.data.transferReference?.trim() || null,request.user!.userId]);
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         SELECT DISTINCT u.id,'PAYMENT_REQUEST_CREATED','طلب قبض جديد للمراجعة',
           'تم تقديم طلب قبض جديد بقيمة ' || $2::text || ' ج.م. راجع الطلب لاتخاذ الإجراء المناسب.',
           'payment_request',$1::uuid
         FROM users u
         JOIN user_roles ur ON ur.user_id=u.id
         JOIN role_permissions rp ON rp.role_id=ur.role_id
         JOIN permissions p ON p.id=rp.permission_id AND p.code='payment_requests.approve'
         JOIN roles r ON r.id=ur.role_id AND r.is_active=TRUE
         WHERE u.is_active=TRUE AND u.id<>$3`,
        [inserted.rows[0].id, inserted.rows[0].amount, request.user!.userId]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:user.employee_id,action:"create",module:"payments",entityType:"payment_request",entityId:inserted.rows[0].id,afterData:inserted.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return inserted.rows[0];
      });
    } catch(error) {
      if(isUniqueViolation(error)) throw new AppError("OPEN_REQUEST_EXISTS","يوجد طلب قبض مفتوح بالفعل",409);
      throw error;
    }
    return reply.code(201).send({data:row});
  });

  app.post("/api/payment-requests/:id/approve",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.approve")]
  },async(request)=>{
    const id=(request.params as {id:string}).id;
    const actionBody=z.object({cashCustodyEmployeeId:z.string().uuid().nullable().optional(),advanceRepaymentAmount:z.number().nonnegative().default(0)}).safeParse(request.body??{});
    if(!actionBody.success)throw new AppError("VALIDATION_ERROR","اختيار العهدة النقدية غير صحيح",422);
    const row=await withTransaction(async(client)=>{
      await assertAccountingPeriodOpen(client);
      const owner=await client.query("SELECT employee_id FROM payment_requests WHERE id=$1",[id]);
      if(!owner.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      await lockEmployee(client,owner.rows[0].employee_id);
      const current=await client.query("SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      if(current.rows[0].status!=="PENDING") throw new AppError("INVALID_STATUS","حالة الطلب لا تسمح بالاعتماد",409);
      if(current.rows[0].requested_by===request.user!.userId) throw new AppError("SELF_APPROVAL","لا يمكنك اعتماد طلب قبض أنشأته بنفسك",409);
      const available=await getAvailableEarnings(client,current.rows[0].employee_id);
      if(Number(current.rows[0].amount)>available+0.009) throw new AppError("INSUFFICIENT_BALANCE","مستحقات الإنتاج المتاحة لم تعد تكفي لهذا الطلب",409);

      const custodyEmployeeId=actionBody.data.cashCustodyEmployeeId??request.user!.employeeId;
      if(!custodyEmployeeId)throw new AppError("CASH_CUSTODY_EMPLOYEE_REQUIRED","اختار الموظف صاحب العهدة التي سيُخصم منها المبلغ",422);
      const settlement=await executeWorkerPayment(client,{
        userId:request.user!.userId,actorEmployeeId:request.user!.employeeId,ipAddress:request.ip,userAgent:request.headers["user-agent"]??null,
        custodyEmployeeId,employeeId:current.rows[0].employee_id,requestId:id,requestCode:String(current.rows[0].code),
        grossAmount:Number(current.rows[0].amount),method:String(current.rows[0].method),transferReference:current.rows[0].transfer_reference??null,
        manualRepaymentAmount:actionBody.data.advanceRepaymentAmount
      });
      const updated=await client.query(
        `UPDATE payment_requests SET status='PAID',reviewed_by=$1,reviewed_at=now(),paid_payment_id=$2,updated_at=now()
          WHERE id=$3 RETURNING *`,
        [request.user!.userId,settlement.payment.id,id]);
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         VALUES($1,'PAYMENT_REQUEST_PAID','تم صرف طلب القبض','تم صرف طلب القبض الخاص بك.','payment_request',$2)`,
        [current.rows[0].requested_by,id]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"approve_and_pay",module:"payments",entityType:"payment_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],metadata:{worker_payment_id:settlement.payment.id,gross_amount:settlement.grossAmount,net_amount:settlement.cashPaid,advance_repayment_amount:settlement.advanceRepaymentAmount,repayments:settlement.repayments},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {request:updated.rows[0],...settlement};
    });
    return {data:row};
  });

  app.post("/api/payment-requests/:id/reject",{
    preHandler:[authenticateRequest,requirePermission("payment_requests.reject")]
  },async(request)=>{
    const id=(request.params as {id:string}).id; const parsed=rejectSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","سبب الرفض مطلوب",422);
    const row=await withTransaction(async(client)=>{
      const current=await client.query("SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      if(current.rows[0].status!=="PENDING") throw new AppError("INVALID_STATUS","حالة الطلب لا تسمح بالرفض",409);
      if(current.rows[0].requested_by===request.user!.userId) throw new AppError("SELF_REVIEW","لا يمكنك مراجعة طلب أنشأته بنفسك",409);
      const updated=await client.query(
        `UPDATE payment_requests SET status='REJECTED',rejection_reason=$1,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$3 RETURNING *`,
        [parsed.data.reason,request.user!.userId,id]);
      await client.query(
        `INSERT INTO user_notifications(user_id,type,title,message,entity_type,entity_id)
         VALUES($1,'PAYMENT_REQUEST_REJECTED','تم رفض طلب القبض','سبب الرفض: ' || $2,'payment_request',$3)`,
        [current.rows[0].requested_by, parsed.data.reason, id]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reject",module:"payments",entityType:"payment_request",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],metadata:{reason:parsed.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:row};
  });

  app.post("/api/payment-requests/:id/pay",{
    preHandler:[authenticateRequest,requirePermission("worker_payments.pay")]
  },async(request)=>{
    const id=(request.params as {id:string}).id;
    const actionBody=z.object({cashCustodyEmployeeId:z.string().uuid().nullable().optional(),advanceRepaymentAmount:z.number().nonnegative().default(0)}).safeParse(request.body??{});
    if(!actionBody.success)throw new AppError("VALIDATION_ERROR","اختيار العهدة النقدية غير صحيح",422);
    const row=await withTransaction(async(client)=>{
      await assertAccountingPeriodOpen(client);
      const owner=await client.query("SELECT employee_id FROM payment_requests WHERE id=$1",[id]);
      if(!owner.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      // Keep the same employee -> request lock order used by request creation and approval.
      await lockEmployee(client,owner.rows[0].employee_id);
      const current=await client.query("SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount) throw new AppError("NOT_FOUND","طلب القبض غير موجود",404);
      if(current.rows[0].status!=="APPROVED") throw new AppError("INVALID_STATUS","يجب اعتماد الطلب قبل الدفع",409);
      const available=await getAvailableEarnings(client,current.rows[0].employee_id);
      if(Number(current.rows[0].amount)>available+0.009) throw new AppError("INSUFFICIENT_BALANCE","مستحقات الإنتاج المتاحة لم تعد تكفي لهذا الطلب",409);
      const custodyEmployeeId=actionBody.data.cashCustodyEmployeeId??request.user!.employeeId;
      if(!custodyEmployeeId)throw new AppError("CASH_CUSTODY_EMPLOYEE_REQUIRED","اختار الموظف صاحب العهدة التي سيُخصم منها المبلغ",422);
      const settlement=await executeWorkerPayment(client,{
        userId:request.user!.userId,actorEmployeeId:request.user!.employeeId,ipAddress:request.ip,userAgent:request.headers["user-agent"]??null,
        custodyEmployeeId,employeeId:current.rows[0].employee_id,requestId:id,requestCode:String(current.rows[0].code),
        grossAmount:Number(current.rows[0].amount),method:String(current.rows[0].method),transferReference:current.rows[0].transfer_reference??null,
        manualRepaymentAmount:actionBody.data.advanceRepaymentAmount
      });
      const updated=await client.query(
        `UPDATE payment_requests SET status='PAID',paid_payment_id=$1,updated_at=now() WHERE id=$2 RETURNING *`,
        [settlement.payment.id,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"pay",module:"payments",entityType:"worker_payment",entityId:settlement.payment.id,afterData:settlement.payment,metadata:{payment_request_id:id,gross_amount:settlement.grossAmount,net_amount:settlement.cashPaid,advance_repayment_amount:settlement.advanceRepaymentAmount,repayments:settlement.repayments},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {request:updated.rows[0],...settlement};
    });
    return {data:row};
  });
  app.get("/api/worker-payments/settlement-summary", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    const parsed = z.object({ employeeId: z.string().uuid(), orderId: z.string().uuid().optional(), orderStageId: z.string().uuid().optional() }).safeParse(request.query);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اختيار العامل غير صحيح", 422);
    const client = await pool.connect();
    try {
      const employee = await client.query(
        "SELECT id,code,full_name FROM employees WHERE id=$1 AND is_active=TRUE",
        [parsed.data.employeeId]
      );
      if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "العامل غير موجود أو غير نشط", 404);
      const [production, adjustments, settlements, legacyPayments, advances, ledger, orderAccount] = await Promise.all([
        client.query(`SELECT COALESCE(SUM(earning_amount),0) AS amount
          FROM production_entries WHERE employee_id=$1 AND status='APPROVED'`, [parsed.data.employeeId]),
        client.query(`SELECT
          COALESCE(SUM(CASE WHEN a.adjustment_type='BONUS' THEN a.amount ELSE 0 END),0) AS bonuses,
          COALESCE(SUM(CASE WHEN a.adjustment_type='DEDUCTION' THEN a.amount ELSE 0 END),0) AS deductions
          FROM employee_earnings_adjustments a
          LEFT JOIN production_entries p ON p.id=a.production_entry_id
          LEFT JOIN order_stages os ON os.id=p.order_stage_id
          WHERE a.employee_id=$1 AND (a.production_entry_id IS NULL OR p.status='APPROVED')
            AND ($2::uuid IS NULL OR os.order_id=$2)
            AND ($3::uuid IS NULL OR p.order_stage_id=$3)`, [parsed.data.employeeId,parsed.data.orderId??null,parsed.data.orderStageId??null]),
        client.query(`SELECT COALESCE(SUM(gross_amount),0) AS amount
          FROM employee_earnings_settlements WHERE employee_id=$1`, [parsed.data.employeeId]),
        client.query(`SELECT COALESCE(SUM(wp.gross_amount),0) AS amount
          FROM worker_payments wp LEFT JOIN employee_earnings_settlements s ON s.worker_payment_id=wp.id
          WHERE wp.employee_id=$1 AND s.id IS NULL`, [parsed.data.employeeId]),
        client.query(`SELECT COALESCE(SUM(GREATEST(a.amount-COALESCE(r.paid,0),0)),0) AS amount
          FROM advance_requests a
          LEFT JOIN (SELECT advance_id,SUM(amount) AS paid FROM advance_repayments GROUP BY advance_id) r ON r.advance_id=a.id
          WHERE a.employee_id=$1 AND a.status='PAID' AND a.repayment_status='OPEN'`, [parsed.data.employeeId]),
        client.query(`SELECT COALESCE(SUM(credit_amount),0) AS credits,
          COALESCE(SUM(debit_amount),0) AS debits
          FROM employee_earnings_ledger WHERE employee_id=$1`, [parsed.data.employeeId]),
        parsed.data.orderId ? client.query(`
          SELECT
            COALESCE((SELECT SUM(COALESCE(p.total_earning_amount,p.earning_amount))
              FROM production_entries p LEFT JOIN order_stages os ON os.id=p.order_stage_id
              WHERE p.employee_id=$1 AND p.status='APPROVED' AND os.order_id=$2
                AND ($3::uuid IS NULL OR p.order_stage_id=$3)),0) AS earned,
            COALESCE((SELECT SUM(a.amount) FROM worker_payment_order_allocations a
              JOIN worker_payments wp ON wp.id=a.worker_payment_id
              JOIN production_entries p ON p.id=a.production_entry_id
              LEFT JOIN order_stages os ON os.id=p.order_stage_id
              WHERE wp.employee_id=$1 AND os.order_id=$2 AND ($3::uuid IS NULL OR p.order_stage_id=$3)),0) AS allocated_paid,
            COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
              JOIN accounting_expenses ae ON ae.idempotency_key=wp.idempotency_key
              WHERE wp.employee_id=$1 AND ae.order_id=$2 AND ($3::uuid IS NULL OR ae.order_stage_id=$3)
                AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations a WHERE a.worker_payment_id=wp.id)),0) AS legacy_order_paid
        `,[parsed.data.employeeId,parsed.data.orderId,parsed.data.orderStageId??null]) : Promise.resolve({rows:[{earned:null,allocated_paid:null,legacy_order_paid:null}]})
      ]);
      const earned = Number(production.rows[0]?.amount ?? 0);
      const bonus = Number(adjustments.rows[0]?.bonuses ?? 0);
      const deductions = Number(adjustments.rows[0]?.deductions ?? 0);
      const settled = Number(settlements.rows[0]?.amount ?? 0);
      const legacyPaid = Number(legacyPayments.rows[0]?.amount ?? 0);
      const available = parsed.data.orderId
        ? Math.max(0,Number(orderAccount.rows[0]?.earned??0)-Number(orderAccount.rows[0]?.allocated_paid??0)-Number(orderAccount.rows[0]?.legacy_order_paid??0))
        : await getAvailableEarnings(client, parsed.data.employeeId);
      return { data: {
        employee: employee.rows[0],
        productionEarnings: earned,
        bonuses: bonus,
        deductions,
        previouslySettled: settled + legacyPaid,
        outstandingAdvances: Number(advances.rows[0]?.amount ?? 0),
        availableForSettlement: available,
        orderAccount: parsed.data.orderId ? {
          orderId: parsed.data.orderId,
          orderStageId: parsed.data.orderStageId ?? null,
          earned: Number(orderAccount.rows[0]?.earned ?? 0),
          paid: Number(orderAccount.rows[0]?.allocated_paid ?? 0)+Number(orderAccount.rows[0]?.legacy_order_paid ?? 0),
          remaining: available
        } : null,
        ledgerCredits: Number(ledger.rows[0]?.credits ?? 0),
        ledgerDebits: Number(ledger.rows[0]?.debits ?? 0)
      }};
    } finally {
      client.release();
    }
  });

  app.get("/api/worker-payments/preview", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request) => {
    const parsed = z.object({
      employeeId: z.string().uuid(),
      cashCustodyEmployeeId: z.string().uuid()
    }).safeParse(request.query);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "اختيار العامل أو العهدة غير صحيح", 422);
    const client = await pool.connect();
    try {
      const availableEarnings = await getAvailableEarnings(client, parsed.data.employeeId);
      const custody = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance
           FROM cash_custody_transactions
          WHERE employee_id=$1 AND transaction_date<=CURRENT_DATE`,
        [parsed.data.cashCustodyEmployeeId]
      );
      const cashCustodyBalance = Math.round(Number(custody.rows[0]?.balance ?? 0) * 100) / 100;
      return { data: {
        availableEarnings,
        cashCustodyBalance,
        maxGrossPayoutWithoutManualOffset: Math.min(availableEarnings, cashCustodyBalance)
      }};
    } finally {
      client.release();
    }
  });

  // Finance may settle an employee's available production earnings directly without a prior payment request.
    app.post("/api/worker-payments/direct", {
    preHandler: [authenticateRequest, requirePermission("worker_payments.pay")]
  }, async (request, reply) => {
    const parsed = z.object({
      employeeId: z.string().uuid(),
      cashCustodyEmployeeId: z.string().uuid().nullable().optional(),
      settlementSource: z.enum(["CURRENT_CUSTODY", "PREVIOUS_CUSTODY"]).default("CURRENT_CUSTODY"),
      orderId: z.string().uuid().nullable().optional(),
      orderStageId: z.string().uuid().nullable().optional(),
      idempotencyKey: z.string().uuid(),
      amount: z.number().positive().max(100000000),
      method: z.string().trim().min(1).max(50).default("CASH"),
      transferReference: z.string().trim().max(120).nullable().optional(),
      advanceRepaymentAmount: z.number().nonnegative().default(0),
      notes: z.string().trim().max(500).nullable().optional()
    }).superRefine((value, ctx) => {
      if (value.settlementSource === "CURRENT_CUSTODY" && !value.cashCustodyEmployeeId) {
        ctx.addIssue({ code: "custom", path: ["cashCustodyEmployeeId"], message: "اختار العهدة الحالية التي سيتم الخصم منها" });
      }
      if (value.settlementSource === "PREVIOUS_CUSTODY" && !value.orderId) {
        ctx.addIssue({ code: "custom", path: ["orderId"], message: "اختيار الطلبية مطلوب عند التسوية من عهدة سابقة" });
      }
      if (value.orderStageId && !value.orderId) {
        ctx.addIssue({ code: "custom", path: ["orderId"], message: "اختيار مرحلة الطلبية يتطلب تحديد الطلبية" });
      }
      if (["VODAFONE_CASH", "INSTAPAY", "BANK"].includes(value.method) && !value.transferReference?.trim()) {
        ctx.addIssue({ code: "custom", path: ["transferReference"], message: "رقم التحويل مطلوب لطريقة الدفع المختارة" });
      }
    }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "راجع بيانات صرف مستحقات العامل واختيار العهدة أو الطلبية", 422);

    const result = await withTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('worker-payment:' || $1))", [parsed.data.idempotencyKey]);
      await lockEmployee(client, parsed.data.employeeId);

      const fingerprint = JSON.stringify({
        employeeId: parsed.data.employeeId,
        settlementSource: parsed.data.settlementSource,
        cashCustodyEmployeeId: parsed.data.cashCustodyEmployeeId ?? null,
        orderId: parsed.data.orderId ?? null,
        orderStageId: parsed.data.orderStageId ?? null,
        amount: parsed.data.amount,
        method: parsed.data.method,
        transferReference: parsed.data.transferReference ?? null,
        advanceRepaymentAmount: parsed.data.advanceRepaymentAmount,
        notes: parsed.data.notes ?? null
      });
      const prior = await client.query(
        `SELECT wp.*,
                c.employee_id AS custody_employee_id,
                e.order_id AS expense_order_id,
                e.order_stage_id AS expense_order_stage_id
           FROM worker_payments wp
           LEFT JOIN cash_custody_transactions c
             ON c.source_type='WORKER_PAYMENT' AND c.source_id=wp.id
           LEFT JOIN accounting_expenses e
             ON e.expense_type='DIRECT' AND e.category='WORKER_PAYMENT' AND e.idempotency_key=wp.idempotency_key
          WHERE wp.idempotency_key=$1
          LIMIT 1`,
        [parsed.data.idempotencyKey]
      );
      if (prior.rowCount) {
        const payment = prior.rows[0];
        const sameRequest = payment.employee_id === parsed.data.employeeId
          && payment.custody_employee_id === (parsed.data.settlementSource === "CURRENT_CUSTODY" ? parsed.data.cashCustodyEmployeeId : null)
          && payment.expense_order_id === (parsed.data.settlementSource === "PREVIOUS_CUSTODY" ? parsed.data.orderId ?? null : null)
          && payment.expense_order_stage_id === (parsed.data.settlementSource === "PREVIOUS_CUSTODY" ? parsed.data.orderStageId ?? null : null)
          && payment.idempotency_fingerprint === fingerprint;
        if (!sameRequest) throw new AppError("IDEMPOTENCY_KEY_REUSED", "مفتاح العملية مستخدم مع بيانات صرف مختلفة", 409);
        return {
          payment,
          grossAmount: Number(payment.gross_amount),
          cashPaid: Number(payment.amount),
          advanceRepaymentAmount: Number(payment.advance_repayment_amount),
          repayments: [],
          replayed: true
        };
      }

      await assertAccountingPeriodOpen(client);
      const available = await getAvailableEarnings(client, parsed.data.employeeId);
      let orderAvailable: number | null = null;
      if(parsed.data.settlementSource==="PREVIOUS_CUSTODY"){
        const orderDue=await client.query(`
          SELECT
            COALESCE((SELECT SUM(COALESCE(p.total_earning_amount,p.earning_amount))
              FROM production_entries p LEFT JOIN order_stages os ON os.id=p.order_stage_id
              WHERE p.employee_id=$1 AND p.status='APPROVED' AND os.order_id=$2
                AND ($3::uuid IS NULL OR p.order_stage_id=$3)),0) AS earned,
            COALESCE((SELECT SUM(a.amount) FROM worker_payment_order_allocations a
              JOIN worker_payments wp ON wp.id=a.worker_payment_id
              JOIN production_entries p ON p.id=a.production_entry_id
              LEFT JOIN order_stages os ON os.id=p.order_stage_id
              WHERE wp.employee_id=$1 AND os.order_id=$2 AND ($3::uuid IS NULL OR p.order_stage_id=$3)),0) AS allocated_paid,
            COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
              JOIN accounting_expenses ae ON ae.idempotency_key=wp.idempotency_key
              WHERE wp.employee_id=$1 AND ae.order_id=$2 AND ($3::uuid IS NULL OR ae.order_stage_id=$3)
                AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations a WHERE a.worker_payment_id=wp.id)),0) AS legacy_order_paid
        `,[parsed.data.employeeId,parsed.data.orderId,parsed.data.orderStageId??null]);
        orderAvailable=Math.max(0,Number(orderDue.rows[0]?.earned??0)-Number(orderDue.rows[0]?.allocated_paid??0)-Number(orderDue.rows[0]?.legacy_order_paid??0));
        if(parsed.data.amount>orderAvailable+0.009)throw new AppError("ORDER_BALANCE_EXCEEDED",`المتبقي على الطلبية المختارة ${orderAvailable.toFixed(2)} ج.م فقط؛ راجع حساب الطلبية قبل الصرف.`,409);
      } else if(parsed.data.amount > available + 0.009) {
        throw new AppError("INSUFFICIENT_BALANCE", `المستحقات المتاحة ${available.toFixed(2)} ج.م فقط`, 409);
      }

      if (parsed.data.settlementSource === "PREVIOUS_CUSTODY") {
        const order = await client.query("SELECT id,code,order_name,status FROM production_orders WHERE id=$1 FOR UPDATE", [parsed.data.orderId]);
        if (!order.rowCount) throw new AppError("ORDER_NOT_FOUND", "الطلبية غير موجودة", 404);
        if (order.rows[0].status === "CANCELLED") throw new AppError("ORDER_CANCELLED", "لا يمكن تحميل تسوية على طلبية ملغاة", 409);
        if (order.rows[0].status === "COMPLETED") throw new AppError("ORDER_NOT_EXPENSABLE", "لا يمكن تحميل تكلفة جديدة على طلبية مكتملة؛ أعد فتحها أولًا", 409);
        if (parsed.data.orderStageId) {
          const stage = await client.query("SELECT id,order_id,status FROM order_stages WHERE id=$1 FOR SHARE", [parsed.data.orderStageId]);
          if (!stage.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND", "مرحلة الطلبية غير موجودة", 404);
          if (stage.rows[0].order_id !== parsed.data.orderId) throw new AppError("ORDER_STAGE_ORDER_MISMATCH", "المرحلة لا تتبع الطلبية المختارة", 422);
          if (stage.rows[0].status === "CANCELLED") throw new AppError("ORDER_STAGE_CANCELLED", "لا يمكن تحميل تكلفة على مرحلة ملغاة", 409);
        }
      }

      const settlement = await executeWorkerPayment(client, {
        userId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
        custodyEmployeeId: parsed.data.cashCustodyEmployeeId ?? parsed.data.employeeId,
        employeeId: parsed.data.employeeId,
        requestId: null,
        requestCode: parsed.data.settlementSource === "PREVIOUS_CUSTODY" ? "تسوية من عهدة سابقة" : "صرف مباشر بدون طلب قبض",
        grossAmount: parsed.data.amount,
        method: parsed.data.method,
        transferReference: parsed.data.transferReference ?? null,
        manualRepaymentAmount: parsed.data.advanceRepaymentAmount,
        idempotencyKey: parsed.data.idempotencyKey,
        idempotencyFingerprint: fingerprint,
        skipCashCustodyOut: parsed.data.settlementSource === "PREVIOUS_CUSTODY"
      });
      if (parsed.data.settlementSource === "PREVIOUS_CUSTODY") {
        let amountToAllocate=Math.round(parsed.data.amount*100)/100;
        const productionRows=await client.query(`
          SELECT p.id,GREATEST(COALESCE(p.total_earning_amount,p.earning_amount,0)
            -COALESCE((SELECT SUM(a.amount) FROM worker_payment_order_allocations a WHERE a.production_entry_id=p.id),0),0) AS remaining
            FROM production_entries p LEFT JOIN order_stages os ON os.id=p.order_stage_id
           WHERE p.employee_id=$1 AND p.status='APPROVED' AND os.order_id=$2
             AND ($3::uuid IS NULL OR p.order_stage_id=$3)
           ORDER BY p.work_date,p.created_at,p.id
           FOR UPDATE OF p
        `,[parsed.data.employeeId,parsed.data.orderId,parsed.data.orderStageId??null]);
        for(const row of productionRows.rows){
          if(amountToAllocate<=0.009)break;
          const amount=Math.round(Math.min(amountToAllocate,Number(row.remaining))*100)/100;
          if(amount<=0)continue;
          await client.query("INSERT INTO worker_payment_order_allocations(worker_payment_id,production_entry_id,amount) VALUES($1,$2,$3) ON CONFLICT(worker_payment_id,production_entry_id) DO NOTHING",[settlement.payment.id,row.id,amount]);
          amountToAllocate=Math.round((amountToAllocate-amount)*100)/100;
        }
        if(amountToAllocate>0.009)throw new AppError("ORDER_ALLOCATION_INCOMPLETE","تعذر توزيع كامل مبلغ الصرف على سجلات الإنتاج المتاحة للطلبية؛ لم يتم اعتماد العملية.",409);
        const expenseOrder = await client.query("SELECT code,order_name FROM production_orders WHERE id=$1", [parsed.data.orderId]);
        await client.query(
          `INSERT INTO accounting_expenses(order_id,order_stage_id,category,description,amount,expense_date,payment_method,created_by,expense_type,paid_from_employee_id,idempotency_key,idempotency_payload_hash)
           VALUES($1,$2,'WORKER_PAYMENT',$3,$4,CURRENT_DATE,$5,$6,'DIRECT',NULL,$7,$8)`,
          [
            parsed.data.orderId,
            parsed.data.orderStageId ?? null,
            `تسوية مستحقات العامل ${String(settlement.payment.code)} من عهدة سابقة — الطلبية ${String(expenseOrder.rows[0]?.code ?? parsed.data.orderId)}${expenseOrder.rows[0]?.order_name ? ` — ${String(expenseOrder.rows[0].order_name)}` : ""}`,
            parsed.data.amount,
            parsed.data.method,
            request.user!.userId,
            parsed.data.idempotencyKey,
            createHash("sha256").update(fingerprint).digest("hex")
          ]
        );
      }
      if (parsed.data.notes?.trim()) {
        await client.query("UPDATE worker_payments SET notes=concat_ws(' | ',notes,$1::text) WHERE id=$2", [parsed.data.notes.trim(), settlement.payment.id]);
      }
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: parsed.data.settlementSource === "PREVIOUS_CUSTODY" ? "previous_custody_worker_settlement" : "direct_worker_payment",
        module: "payments",
        entityType: "worker_payment",
        entityId: settlement.payment.id,
        afterData: settlement.payment,
        metadata: {
          employeeId: parsed.data.employeeId,
          settlementSource: parsed.data.settlementSource,
          orderId: parsed.data.orderId ?? null,
          orderStageId: parsed.data.orderStageId ?? null,
          grossAmount: settlement.grossAmount,
          cashPaid: settlement.cashPaid,
          advanceRepaymentAmount: settlement.advanceRepaymentAmount
        },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });
      return { ...settlement, replayed: false, settlementSource: parsed.data.settlementSource };
    });
    const { replayed, ...responseData } = result;
    return reply.code(replayed ? 200 : 201).send({ data: responseData });
  });

}
