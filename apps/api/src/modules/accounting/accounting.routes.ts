import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { processMaturedWorkerPaymentDifferences } from "../payments/worker-payment-differences.service.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { assertAccountingPeriodOpen } from "./period-lock.service.js";

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
  historicalSettlement:z.boolean().default(false),
  idempotencyKey:z.string().uuid().optional()
}).superRefine((v,ctx)=>{
  if(v.expenseType==="ADMINISTRATIVE"&&(v.orderId||v.orderStageId)){
    ctx.addIssue({code:"custom",path:["orderId"],message:"المصروف الإداري يوزع على الطلبيات وقت التصفية ولا يرتبط بطلبية أو مرحلة واحدة"});
  }
  if(v.orderStageId&&!v.orderId){
    ctx.addIssue({code:"custom",path:["orderId"],message:"اختيار مرحلة إنتاج يتطلب اختيار الطلبية أولًا"});
  }
  if(v.historicalSettlement&&v.paidFromEmployeeId){
    ctx.addIssue({code:"custom",path:["paidFromEmployeeId"],message:"تسوية السجل القديم لا يجوز أن تخصم من عهدة حالية"});
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

async function assertAccountingDateOpen(client:import("pg").PoolClient,date:string|undefined,requirePeriod=false){
 // Lock the matching period row so closing the period cannot race with a posting.
 const result=await client.query("SELECT id,name,status FROM accounting_periods WHERE COALESCE($1::date,current_date) BETWEEN period_start AND period_end ORDER BY period_start LIMIT 1 FOR SHARE",[date??null]);
 if(!result.rowCount){
  if(requirePeriod)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","لا توجد فترة مالية مفتوحة تغطي تاريخ تسوية السجل القديم؛ أنشئ الفترة يدويًا أولًا.",409);
  return;
 }
 if(result.rows[0].status!=="OPEN")throw new AppError("ACCOUNTING_PERIOD_CLOSED","الفترة المالية ليست مفتوحة؛ لا يمكن تسجيل حركة عادية عليها. استخدم إجراء التصحيح المعتمد.",409);
}

export async function accountingRoutes(app:FastifyInstance){

 const reversalSchema=z.object({
  sourceType:z.enum(["PAYROLL_PAYMENT","ADVANCE_REPAYMENT","ZERO_NET_PAYROLL_SETTLEMENT","WORKER_PAYMENT","WORKER_SETTLEMENT_DIFFERENCE_EVENT"]),
  sourceId:z.string().uuid(),
  amount:z.number().positive().max(100000000).refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,{message:"المبلغ يجب أن يكون بحد أقصى منزلتين عشريتين"}),
  reason:z.string().trim().min(2).max(500),
  idempotencyKey:z.string().uuid()
 });
 app.get("/api/accounting/reversals",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view")]},async()=>{ const result=await pool.query(`SELECT r.id,r.code,r.reason,r.reversal_date,r.created_at,u.username AS created_by_username,l.source_type,l.source_id,l.amount,
  COALESCE((SELECT json_agg(jsonb_build_object('allocation_source',wa.allocation_source,'source_allocation_id',wa.source_allocation_id,'production_entry_id',wa.production_entry_id,'amount',wa.amount) ORDER BY wa.id) FROM worker_payment_allocation_reversals wa WHERE wa.reversal_id=r.id),'[]'::json) AS allocation_reversals,
  COALESCE((SELECT json_agg(jsonb_build_object('expense_id',er.expense_id,'amount',er.amount) ORDER BY er.id) FROM accounting_expense_reversals er WHERE er.reversal_id=r.id),'[]'::json) AS expense_reversals
 FROM financial_reversals r JOIN users u ON u.id=r.created_by JOIN financial_reversal_lines l ON l.reversal_id=r.id ORDER BY r.created_at DESC,l.source_type,l.source_id LIMIT 200`); return {data:result.rows}; });
 app.post("/api/accounting/reversals",{preHandler:[authenticateRequest,requirePermission("finance.reversals.create")]},async(request,reply)=>{
  const parsed=reversalSchema.safeParse(request.body);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات العكس المحاسبي غير صحيحة",422);
  const input=parsed.data;
  const requestFingerprint=createHash("sha256").update(JSON.stringify({sourceType:input.sourceType,sourceId:input.sourceId,amountMinor:Math.round(input.amount*100),reason:input.reason})).digest("hex");
  const result=await withTransaction(async client=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[input.idempotencyKey]);
   const replay=await client.query("SELECT * FROM financial_reversals WHERE idempotency_key=$1 FOR UPDATE",[input.idempotencyKey]);
   if(replay.rowCount){
    if(replay.rows[0].request_fingerprint!==requestFingerprint)throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح العكس مستخدم لعملية مختلفة؛ أنشئ مفتاحًا جديدًا",409);
    const lines=await client.query("SELECT source_type,source_id,amount FROM financial_reversal_lines WHERE reversal_id=$1 ORDER BY source_type,source_id",[replay.rows[0].id]);
    return {replayed:true,reversal:replay.rows[0],lines:lines.rows};
   }
   const reversalDate=new Date().toISOString().slice(0,10);
   await assertAccountingPeriodOpen(client,reversalDate);
   const lines:Array<{source_type:string;source_id:string;amount:number}>=[];
   const ledgerMoves:Array<{employeeId:string;credit:number;debit:number;notes:string}>=[];
   const custodyMoves:Array<{employeeId:string;direction:"IN"|"OUT";amount:number;description:string}>=[];
   const allocationReversals:Array<{workerPaymentId:string;source:string;sourceAllocationId:string;productionEntryId:string;amount:number}>=[];
   const expenseReversals:Array<{expenseId:string;workerPaymentId:string;amount:number}>=[];
   let payrollItemId:string|null=null;
   let zeroNetPayrollItemId:string|null=null;
   const advanceIds=new Set<string>();
   let settlementDifferenceEventReversal:{event:any;differenceId:string}|null=null;
   if(input.sourceType==="PAYROLL_PAYMENT"){
    const q=await client.query(`SELECT pp.*,i.employee_id,i.net_amount,p.status AS period_status
      FROM payroll_payments pp JOIN payroll_items i ON i.id=pp.payroll_item_id
      JOIN payroll_periods p ON p.id=i.period_id WHERE pp.id=$1 FOR UPDATE OF pp,i,p`,[input.sourceId]);
    if(!q.rowCount)throw new AppError("REVERSAL_SOURCE_NOT_FOUND","دفعة الراتب الأصلية غير موجودة",404);
    const payment=q.rows[0]; payrollItemId=payment.payroll_item_id;
    if(payment.period_status==="DRAFT")throw new AppError("PAYROLL_NOT_APPROVED","لا يمكن عكس دفعة مرتبطة بمسير غير معتمد",409);
    const prior=await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='PAYROLL_PAYMENT' AND source_id=$1",[input.sourceId]);
    const remaining=Number(payment.amount)-Number(prior.rows[0].amount);
    if(input.amount>remaining+0.0001)throw new AppError("REVERSAL_EXCEEDS_REMAINING","مبلغ العكس أكبر من المتبقي من الحركة الأصلية",409);
    const linked=await client.query(`SELECT ar.id,ar.advance_id,ar.amount,a.employee_id,a.code
      FROM advance_repayments ar JOIN advance_requests a ON a.id=ar.advance_id
      WHERE ar.source_payroll_payment_id=$1 ORDER BY ar.id FOR UPDATE OF ar,a`,[input.sourceId]);
    let linkedAmount=0;
    let linkedOriginalAmount=0;
    const linkedByAdvance=new Map<string,number>();
    for(const ar of linked.rows){
     linkedOriginalAmount+=Number(ar.amount);
     linkedByAdvance.set(ar.advance_id,(linkedByAdvance.get(ar.advance_id)??0)+Number(ar.amount));
     // A payroll reversal also reverses every linked advance repayment. Validate each
     // original repayment posting before creating the bundle; checking only the net
     // payroll debit would allow a corrupted advance ledger to be reversed silently.
     const repaymentLedger=await client.query(
      "SELECT employee_id,credit_amount,debit_amount FROM employee_earnings_ledger WHERE advance_repayment_id=$1 FOR UPDATE",[ar.id]);
     if(repaymentLedger.rowCount!==1||repaymentLedger.rows[0].employee_id!==ar.employee_id||
        Math.abs(Number(repaymentLedger.rows[0].credit_amount)-Number(ar.amount))>0.01||
        Number(repaymentLedger.rows[0].debit_amount)!==0)
      throw new AppError("REVERSAL_ADVANCE_LEDGER_MISMATCH","قيد أحد أقساط السلف المرتبطة بالراتب غير موجود أو لا يطابق الموظف والمبلغ؛ أوقفنا العكس لحماية دفتر الموظف",409);
     const rev=await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",[ar.id]);
     linkedAmount+=Math.max(0,Number(ar.amount)-Number(rev.rows[0].amount));
    }
    const deductions=await client.query(
     "SELECT advance_id,amount FROM payroll_advance_deductions WHERE payroll_item_id=$1 FOR UPDATE",[payment.payroll_item_id]);
    const deductionByAdvance=new Map<string,number>();
    for(const row of deductions.rows)deductionByAdvance.set(row.advance_id,(deductionByAdvance.get(row.advance_id)??0)+Number(row.amount));
    if(linkedOriginalAmount>0.0001&&(deductionByAdvance.size!==linkedByAdvance.size||
       [...deductionByAdvance].some(([advanceId,amount])=>Math.abs(amount-(linkedByAdvance.get(advanceId)??0))>0.01)))
     throw new AppError("REVERSAL_ADVANCE_ALLOCATION_MISMATCH","أقساط السلف المسجلة في المسير لا تطابق عمليات السداد المرتبطة بدفعة الراتب؛ أوقفنا العكس لحماية الأرصدة",409);
    if(linkedAmount>0.0001&&input.amount<remaining-0.0001)
     throw new AppError("PAYROLL_REVERSAL_BUNDLE_REQUIRED","هذه الدفعة سوّت أقساط سلف؛ يجب عكس المتبقي من الدفعة بالكامل مع تسوية السلف المرتبطة",409);
    lines.push({source_type:"PAYROLL_PAYMENT",source_id:input.sourceId,amount:input.amount});
    for(const ar of linked.rows){
     const rev=await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",[ar.id]);
     const amount=Math.max(0,Number(ar.amount)-Number(rev.rows[0].amount));
     if(amount>0.0001){
      lines.push({source_type:"ADVANCE_REPAYMENT",source_id:ar.id,amount});
      advanceIds.add(ar.advance_id);
      // Keep the repayment's employee-ledger reversal separate from the payroll
      // payment reversal: the original repayment posted its own credit entry.
      ledgerMoves.push({employeeId:ar.employee_id,credit:0,debit:amount,notes:"عكس سداد سلفة "+ar.code+" / "+ar.id});
     }
    }
    const ledger=await client.query("SELECT employee_id,credit_amount,debit_amount FROM employee_earnings_ledger WHERE payroll_payment_id=$1 FOR UPDATE",[input.sourceId]);
    if(!ledger.rowCount)throw new AppError("REVERSAL_LEDGER_MISSING","قيد دفتر الموظف الأصلي غير موجود؛ أوقفنا العكس لحماية الأرصدة",409);
    if(Number(ledger.rows[0].credit_amount)!==0||Math.abs(Number(ledger.rows[0].debit_amount)-Number(payment.amount)-linkedOriginalAmount)>0.01)
     throw new AppError("REVERSAL_LEDGER_MISMATCH","قيد الراتب الأصلي لا يطابق مبلغ الدفعة وأقساط السلف المرتبطة؛ أوقفنا العكس لحماية دفتر الموظف",409);
    ledgerMoves.push({employeeId:ledger.rows[0].employee_id,credit:input.amount+linkedAmount,debit:0,notes:"عكس صرف راتب "+input.sourceId});
    const out=await client.query("SELECT employee_id,amount FROM cash_custody_transactions WHERE source_type='PAYROLL_PAYMENT' AND source_id=$1 AND direction='OUT' FOR UPDATE",[input.sourceId]);
    const offset=await client.query("SELECT employee_id,amount FROM cash_custody_transactions WHERE source_type='PAYROLL_ADVANCE_REPAYMENT_OFFSET' AND source_id=$1 AND direction='IN' FOR UPDATE",[input.sourceId]);
    if(Number(out.rowCount??0)>1||Number(offset.rowCount??0)>1)throw new AppError("REVERSAL_CUSTODY_AMBIGUOUS","حركات العهدة المرتبطة بالدفعة غير متطابقة؛ راجع المطابقة قبل العكس",409);
    if(offset.rowCount&&Math.abs(Number(offset.rows[0].amount)-linkedOriginalAmount)>0.01)
     throw new AppError("REVERSAL_CUSTODY_OFFSET_MISMATCH","استرداد العهدة الأصلي لا يطابق إجمالي أقساط السلف؛ أوقفنا العكس لحماية رصيد العهدة",409);
    if(out.rowCount){
     if(Math.abs(Number(out.rows[0].amount)-Number(payment.amount)-linkedOriginalAmount)>0.01)
      throw new AppError("REVERSAL_CUSTODY_PAYMENT_MISMATCH","حركة خروج العهدة الأصلية لا تطابق صافي الصرف وأقساط السلف؛ أوقفنا العكس لحماية رصيد العهدة",409);
     if(offset.rowCount&&offset.rows[0].employee_id!==out.rows[0].employee_id)throw new AppError("REVERSAL_CUSTODY_HOLDER_MISMATCH","صاحب العهدة مختلف بين حركات الصرف وتسوية السلف",409);
     custodyMoves.push({employeeId:out.rows[0].employee_id,direction:"IN",amount:input.amount+linkedAmount,description:"استرداد عكس صرف راتب "+input.sourceId});
     if(linkedAmount>0.0001)custodyMoves.push({employeeId:out.rows[0].employee_id,direction:"OUT",amount:linkedAmount,description:"عكس استرداد أقساط السلف من الراتب "+input.sourceId});
    }else if(offset.rowCount)throw new AppError("REVERSAL_CUSTODY_INCOMPLETE","يوجد استرداد عهدة دون حركة الصرف المقابلة؛ راجع المطابقة قبل العكس",409);
   }else if(input.sourceType==="WORKER_PAYMENT"){
    // Match production approval's employee-first lock order. This serializes
    // reversal against a concurrent approval that may allocate an old difference
    // to the newly approved production entry.
    const paymentIdentity=await client.query(
     "SELECT employee_id FROM worker_payments WHERE id=$1",[input.sourceId]);
    if(!paymentIdentity.rowCount)throw new AppError("REVERSAL_SOURCE_NOT_FOUND","دفعة العامل الأصلية غير موجودة",404);
    await client.query("SELECT id FROM employees WHERE id=$1 FOR UPDATE",[paymentIdentity.rows[0].employee_id]);
    const paymentResult=await client.query(
     `SELECT wp.*,e.full_name AS employee_name,wp.created_at::date::text AS payment_created_date
        FROM worker_payments wp JOIN employees e ON e.id=wp.employee_id
       WHERE wp.id=$1 FOR UPDATE OF wp`,[input.sourceId]);
    if(!paymentResult.rowCount)throw new AppError("REVERSAL_SOURCE_NOT_FOUND","دفعة العامل الأصلية غير موجودة",404);
    const payment=paymentResult.rows[0];
    const gross=Number(payment.gross_amount),cashPaid=Number(payment.amount),advanceAmount=Number(payment.advance_repayment_amount??0);
    if(!Number.isFinite(gross)||!Number.isFinite(cashPaid)||!Number.isFinite(advanceAmount)||
       gross<=0||cashPaid<0||advanceAmount<0||Math.abs(gross-cashPaid-advanceAmount)>0.01)
     throw new AppError("WORKER_PAYMENT_AMOUNT_MISMATCH","إجمالي الدفعة لا يساوي النقد المصروف مضافًا إليه سداد السلف؛ أوقفنا العكس",409);
    const settlement=await client.query(
     `SELECT id,employee_id,gross_amount,cash_paid_amount,advance_repayment_amount,notes
        FROM employee_earnings_settlements WHERE worker_payment_id=$1 FOR UPDATE`,[input.sourceId]);
    if(settlement.rowCount!==1||settlement.rows[0].employee_id!==payment.employee_id||
       Math.abs(Number(settlement.rows[0].gross_amount)-gross)>0.01||
       Math.abs(Number(settlement.rows[0].cash_paid_amount)-cashPaid)>0.01||
       Math.abs(Number(settlement.rows[0].advance_repayment_amount)-advanceAmount)>0.01)
     throw new AppError("WORKER_PAYMENT_SETTLEMENT_MISMATCH","تسوية العامل المرتبطة بالدفعة غير موجودة أو لا تطابق مبالغ الدفعة؛ أوقفنا العكس",409);
    const previousCustodySettlement=String(settlement.rows[0].notes??"").includes("تسوية من عهدة سابقة");
    if(Math.abs(input.amount-gross)>0.01)
     throw new AppError("WORKER_PAYMENT_FULL_REVERSAL_REQUIRED","عكس دفعة العامل يتطلب عكس إجمالي الدفعة بالكامل؛ العكس الجزئي غير متاح قبل مطابقة جميع آثارها",409);
    const priorPayment=await client.query(
     "SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='WORKER_PAYMENT' AND source_id=$1",[input.sourceId]);
    if(Number(priorPayment.rows[0].amount)>0.0001)
     throw new AppError("WORKER_PAYMENT_ALREADY_REVERSED","دفعة العامل سبق عكسها؛ لا يمكن تكرار العكس",409);

    const paymentLedger=await client.query(
     `SELECT employee_id,credit_amount,debit_amount FROM employee_earnings_ledger
       WHERE worker_payment_id=$1 FOR UPDATE`,[input.sourceId]);
    if(paymentLedger.rowCount!==1||paymentLedger.rows[0].employee_id!==payment.employee_id||
       Number(paymentLedger.rows[0].credit_amount)!==0||
       Math.abs(Number(paymentLedger.rows[0].debit_amount)-gross)>0.01)
     throw new AppError("WORKER_PAYMENT_LEDGER_MISMATCH","قيد مستحقات العامل الأصلي غير موجود أو لا يطابق الموظف وإجمالي الدفعة؛ أوقفنا العكس",409);

    const repayments=await client.query(
     `SELECT ar.id,ar.advance_id,ar.amount,ar.source_worker_payment_id,ar.settlement_id,a.employee_id,a.code
        FROM advance_repayments ar JOIN advance_requests a ON a.id=ar.advance_id
       WHERE ar.source_worker_payment_id=$1 OR ar.settlement_id=$2 ORDER BY ar.id FOR UPDATE OF ar,a`,[input.sourceId,settlement.rows[0].id]);
    const repaymentTotal=repayments.rows.reduce((sum,row)=>sum+Number(row.amount),0);
    if(Math.abs(repaymentTotal-advanceAmount)>0.01)
     throw new AppError("WORKER_PAYMENT_ADVANCE_MISMATCH","مجموع سداد السلف المرتبط بالدفعة لا يطابق مبلغ سداد السلف المسجل؛ أوقفنا العكس",409);
    for(const repayment of repayments.rows){
     if(repayment.employee_id!==payment.employee_id||
        (repayment.source_worker_payment_id&&repayment.source_worker_payment_id!==input.sourceId)||
        (repayment.settlement_id&&repayment.settlement_id!==settlement.rows[0].id))
      throw new AppError("WORKER_PAYMENT_ADVANCE_OWNER_MISMATCH","سداد سلفة مرتبط لا يخص العامل صاحب الدفعة أو يشير إلى تسوية مختلفة؛ أوقفنا العكس للمراجعة",409);
     const repaymentLedger=await client.query(
      "SELECT employee_id,credit_amount,debit_amount FROM employee_earnings_ledger WHERE advance_repayment_id=$1 FOR UPDATE",[repayment.id]);
     if(repaymentLedger.rowCount!==1||repaymentLedger.rows[0].employee_id!==repayment.employee_id||
        Math.abs(Number(repaymentLedger.rows[0].credit_amount)-Number(repayment.amount))>0.01||
        Number(repaymentLedger.rows[0].debit_amount)!==0)
      throw new AppError("WORKER_PAYMENT_ADVANCE_LEDGER_MISMATCH","قيد سداد إحدى السلف المرتبطة غير موجود أو غير مطابق؛ أوقفنا العكس",409);
     const priorRepayment=await client.query(
      "SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",[repayment.id]);
     if(Number(priorRepayment.rows[0].amount)>0.0001)
      throw new AppError("WORKER_PAYMENT_ADVANCE_ALREADY_REVERSED","يوجد سداد سلفة مرتبط سبق عكسه بصورة مستقلة؛ يلزم فحص يدوي قبل عكس الدفعة",409);
     lines.push({source_type:"ADVANCE_REPAYMENT",source_id:repayment.id,amount:Number(repayment.amount)});
     advanceIds.add(repayment.advance_id);
     ledgerMoves.push({employeeId:repayment.employee_id,credit:0,debit:Number(repayment.amount),notes:"عكس سداد سلفة "+repayment.code+" / "+repayment.id});
    }

    // Resolve the same canonical allocation source used by production reports:
    // settlement allocations take precedence, then order allocations, then legacy allocations.
    const settlementAllocations=await client.query(
     `SELECT a.id,a.production_entry_id,a.amount,p.employee_id,p.status,
             NOT EXISTS(SELECT 1 FROM worker_payment_allocation_reversals r WHERE r.allocation_source='EMPLOYEE_EARNINGS_SETTLEMENT' AND r.source_allocation_id=a.id) AS active
        FROM employee_earnings_settlement_allocations a
        JOIN employee_earnings_settlements s ON s.id=a.settlement_id
        JOIN production_entries p ON p.id=a.production_entry_id
       WHERE s.worker_payment_id=$1 ORDER BY a.id FOR UPDATE OF a,p`,[input.sourceId]);
    const orderAllocations=await client.query(
     `SELECT a.id,a.production_entry_id,a.amount,p.employee_id,p.status,
             NOT EXISTS(SELECT 1 FROM worker_payment_allocation_reversals r WHERE r.allocation_source='WORKER_PAYMENT_ORDER' AND r.source_allocation_id=a.id) AS active
        FROM worker_payment_order_allocations a
        JOIN production_entries p ON p.id=a.production_entry_id
       WHERE a.worker_payment_id=$1 ORDER BY a.id FOR UPDATE OF a,p`,[input.sourceId]);
    const legacyAllocations=await client.query(
     `SELECT a.id,a.production_entry_id,a.amount,p.employee_id,p.status,
             NOT EXISTS(SELECT 1 FROM worker_payment_allocation_reversals r WHERE r.allocation_source='WORKER_PAYMENT_LEGACY' AND r.source_allocation_id=a.id) AS active
        FROM worker_payment_allocations a
        JOIN production_entries p ON p.id=a.production_entry_id
       WHERE a.worker_payment_id=$1 ORDER BY a.id FOR UPDATE OF a,p`,[input.sourceId]);
    const chosenSource=settlementAllocations.rowCount?"EMPLOYEE_EARNINGS_SETTLEMENT":
     orderAllocations.rowCount?"WORKER_PAYMENT_ORDER":"WORKER_PAYMENT_LEGACY";
    const chosenRows=settlementAllocations.rowCount?settlementAllocations.rows:
     orderAllocations.rowCount?orderAllocations.rows:legacyAllocations.rows;
    const chosenAllocations={rows:chosenRows.filter((row:any)=>row.active),source:chosenSource};
    const allocatedTotal=chosenAllocations.rows.reduce((sum,row)=>sum+Number(row.amount),0);
    if(allocatedTotal>gross+0.01)
     throw new AppError("WORKER_PAYMENT_ALLOCATION_EXCEEDS_GROSS","توزيعات الإنتاج المرتبطة بالدفعة تتجاوز إجماليها؛ أوقفنا العكس",409);
    if(chosenAllocations.rows.some(row=>row.employee_id!==payment.employee_id||row.status!=="APPROVED"||Number(row.amount)<=0))
     throw new AppError("WORKER_PAYMENT_ALLOCATION_MISMATCH","يوجد توزيع إنتاج لا يخص العامل أو لم يعد إنتاجًا معتمدًا؛ أوقفنا العكس للمراجعة",409);
    const productionIds=chosenAllocations.rows.map(row=>row.production_entry_id);
    if(productionIds.length){
     const later=await client.query(
      `SELECT 1 FROM worker_payments later
        WHERE later.employee_id=$1 AND later.id<>$2 AND later.created_at>(
          SELECT created_at FROM worker_payments WHERE id=$2
        ) AND (
          EXISTS(SELECT 1 FROM worker_payment_order_allocations a WHERE a.worker_payment_id=later.id AND a.production_entry_id=ANY($3::uuid[]))
          OR EXISTS(SELECT 1 FROM worker_payment_allocations a WHERE a.worker_payment_id=later.id AND a.production_entry_id=ANY($3::uuid[]))
          OR EXISTS(SELECT 1 FROM employee_earnings_settlements s JOIN employee_earnings_settlement_allocations a ON a.settlement_id=s.id WHERE s.worker_payment_id=later.id AND a.production_entry_id=ANY($3::uuid[]))
        ) LIMIT 1 FOR UPDATE OF later`,[payment.employee_id,input.sourceId,productionIds]);
     if(later.rowCount)throw new AppError("WORKER_PAYMENT_HAS_DEPENDENT_SETTLEMENT","توجد دفعة لاحقة مرتبطة بسجلات الإنتاج نفسها؛ يلزم مراجعة تسلسل التسويات قبل العكس",409);
    }
    for(const allocation of chosenAllocations.rows){
     allocationReversals.push({workerPaymentId:input.sourceId,source:chosenAllocations.source,sourceAllocationId:allocation.id,
      productionEntryId:allocation.production_entry_id,amount:Number(allocation.amount)});
    }

    const expenses=await client.query(
     `SELECT id,amount,paid_from_employee_id,cash_custody_transaction_id
        FROM accounting_expenses
       WHERE source_worker_payment_id=$1 OR (source_worker_payment_id IS NULL AND idempotency_key=$2)
       ORDER BY id FOR UPDATE`,[input.sourceId,payment.idempotency_key]);
    if(!expenses.rowCount)
     throw new AppError("WORKER_PAYMENT_EXPENSE_LINK_MISSING","لا توجد مصروفات مرتبطة بمصدر دفعة العامل؛ يلزم استكمال المطابقة التاريخية قبل العكس",409);
    const expenseTotal=expenses.rows.reduce((sum,row)=>sum+Number(row.amount),0);
    if(Math.abs(expenseTotal-gross)>0.01)
     throw new AppError("WORKER_PAYMENT_EXPENSE_MISMATCH","إجمالي مصروفات الطلبات المرتبطة لا يطابق إجمالي الدفعة؛ أوقفنا العكس",409);
    const priorExpenses=await client.query(
     "SELECT COALESCE(SUM(er.amount),0) AS amount FROM accounting_expense_reversals er WHERE er.source_worker_payment_id=$1",[input.sourceId]);
    if(Number(priorExpenses.rows[0].amount)>0.0001)
     throw new AppError("WORKER_PAYMENT_EXPENSE_ALREADY_REVERSED","يوجد أثر مصروفات مرتبط بالدفعة سبق عكسه؛ يلزم فحص يدوي",409);
    for(const expense of expenses.rows)expenseReversals.push({expenseId:expense.id,workerPaymentId:input.sourceId,amount:Number(expense.amount)});

    // Only a recorded physical OUT can be restored to custody. Absence of an OUT
    // is valid for previous-custody settlements and must never create a fictional IN.
    const custody=await client.query(
     `SELECT id,employee_id,amount,transaction_date::text AS transaction_date FROM cash_custody_transactions
       WHERE source_type='WORKER_PAYMENT' AND source_id=$1 AND direction='OUT'
       ORDER BY id FOR UPDATE`,[input.sourceId]);
    if(Number(custody.rowCount??0)>1)throw new AppError("WORKER_PAYMENT_CUSTODY_AMBIGUOUS","توجد أكثر من حركة خروج نقدي مرتبطة بالدفعة؛ أوقفنا العكس",409);
    const expenseCustodyRows=expenses.rows.filter(row=>row.paid_from_employee_id);
    const expenseCustodyLinks=expenses.rows.filter(row=>row.cash_custody_transaction_id);
    if(Number(custody.rowCount??0)===1){
     if(previousCustodySettlement)
      throw new AppError("WORKER_PAYMENT_PREVIOUS_CUSTODY_CONFLICT","التسوية موثقة كعهدة سابقة رغم وجود خروج نقدي مرتبط بالدفعة؛ أوقفنا العكس",409);
     if(Math.abs(Number(custody.rows[0].amount)-cashPaid)>0.01||
        custody.rows[0].transaction_date!==payment.payment_created_date||
        expenseCustodyRows.length!==1||expenseCustodyRows[0].paid_from_employee_id!==custody.rows[0].employee_id||
        expenseCustodyLinks.length!==1||expenseCustodyLinks[0].cash_custody_transaction_id!==custody.rows[0].id)
      throw new AppError("WORKER_PAYMENT_CUSTODY_MISMATCH","حركة خروج العهدة وتاريخها وربطها بالمصروف وصاحب العهدة لا تطابق الدفعة؛ أوقفنا العكس",409);
     if(cashPaid>0.009)custodyMoves.push({employeeId:custody.rows[0].employee_id,direction:"IN",amount:cashPaid,description:"استرداد عكس دفعة العامل "+payment.id});
    }else if(cashPaid>0.009){
     if(!previousCustodySettlement||expenseCustodyRows.length||expenseCustodyLinks.length)
      throw new AppError("WORKER_PAYMENT_CUSTODY_LINK_MISSING","لا توجد حركة خروج نقدي موثقة أو لا يثبت سجل المصروف أن التسوية تمت من عهدة سابقة؛ أوقفنا العكس",409);
    }else if(expenseCustodyRows.length||expenseCustodyLinks.length){
     throw new AppError("WORKER_PAYMENT_CUSTODY_ZERO_MISMATCH","صافي النقد صفر لكن مصروفات الدفعة تحتوي على رابط عهدة نقدية؛ أوقفنا العكس",409);
    }

    lines.push({source_type:"WORKER_PAYMENT",source_id:input.sourceId,amount:gross});
    ledgerMoves.push({employeeId:payment.employee_id,credit:gross,debit:0,notes:"عكس دفعة العامل "+payment.id});
   }else if(input.sourceType==="ZERO_NET_PAYROLL_SETTLEMENT"){
    const itemResult=await client.query(
     `SELECT i.*,p.status AS period_status
        FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id
       WHERE i.id=$1 FOR UPDATE OF i,p`,[input.sourceId]);
    if(!itemResult.rowCount)throw new AppError("REVERSAL_SOURCE_NOT_FOUND","بند تسوية الراتب غير موجود",404);
    const item=itemResult.rows[0];
    if(item.period_status==="DRAFT")throw new AppError("PAYROLL_NOT_APPROVED","لا يمكن عكس تسوية مرتبطة بمسير غير معتمد",409);
    if(item.status!=="PAID"||Number(item.net_amount)>0.01||Number(item.advance_repayment_amount)<=0.01)
     throw new AppError("ZERO_NET_SETTLEMENT_NOT_REVERSIBLE","بند الراتب ليس تسوية سلف بصافي صفر قابلة للعكس",409);
    const grossSalary=Number(item.base_salary)+Number(item.bonus_amount)-Number(item.deduction_amount);
    const advanceAmount=Number(item.advance_repayment_amount);
    if(grossSalary<=0.01||Math.abs(grossSalary-advanceAmount)>0.01||Math.abs(input.amount-grossSalary)>0.01)
     throw new AppError("ZERO_NET_SETTLEMENT_AMOUNT_MISMATCH","مبلغ العكس يجب أن يساوي كامل قيمة تسوية الراتب غير النقدية",409);
    const priorSettlement=await client.query(
     "SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='ZERO_NET_PAYROLL_SETTLEMENT' AND source_id=$1",
     [item.id]);
    if(Number(priorSettlement.rows[0].amount)>0.01)
     throw new AppError("ZERO_NET_SETTLEMENT_ALREADY_REVERSED","تم عكس تسوية هذا الراتب من قبل",409);
    const offset=await client.query(
     "SELECT employee_id,debit_amount,credit_amount FROM employee_earnings_ledger WHERE payroll_advance_offset_item_id=$1 FOR UPDATE",
     [item.id]);
    if(offset.rowCount!==1||offset.rows[0].employee_id!==item.employee_id||
       Math.abs(Number(offset.rows[0].debit_amount)-grossSalary)>0.01||Number(offset.rows[0].credit_amount)!==0)
     throw new AppError("ZERO_NET_OFFSET_LEDGER_MISMATCH","قيد تسوية الراتب غير موجود أو لا يطابق الموظف والمبلغ؛ أوقفنا العكس لحماية دفتر الموظف",409);
    const repayments=await client.query(
     `SELECT ar.id,ar.advance_id,ar.amount,a.employee_id,a.code
        FROM advance_repayments ar JOIN advance_requests a ON a.id=ar.advance_id
       WHERE ar.source_payroll_item_id=$1 AND ar.source_payroll_payment_id IS NULL AND ar.source_worker_payment_id IS NULL
       ORDER BY ar.id FOR UPDATE OF ar,a`,[item.id]);
    if(!repayments.rowCount)throw new AppError("ZERO_NET_REPAYMENTS_MISSING","لا توجد أقساط سلف مرتبطة بتسوية الراتب؛ أوقفنا العكس",409);
    const deductions=await client.query(
     "SELECT advance_id,amount FROM payroll_advance_deductions WHERE payroll_item_id=$1 FOR UPDATE",[item.id]);
    const repaymentByAdvance=new Map<string,number>();
    const deductionByAdvance=new Map<string,number>();
    for(const ar of repayments.rows)repaymentByAdvance.set(ar.advance_id,(repaymentByAdvance.get(ar.advance_id)??0)+Number(ar.amount));
    for(const row of deductions.rows)deductionByAdvance.set(row.advance_id,(deductionByAdvance.get(row.advance_id)??0)+Number(row.amount));
    const repaymentTotal=repayments.rows.reduce((sum,row)=>sum+Number(row.amount),0);
    if(Math.abs(repaymentTotal-advanceAmount)>0.01||deductionByAdvance.size!==repaymentByAdvance.size||
       [...deductionByAdvance].some(([advanceId,amount])=>Math.abs(amount-(repaymentByAdvance.get(advanceId)??0))>0.01))
     throw new AppError("ZERO_NET_ADVANCE_ALLOCATION_MISMATCH","أقساط السلف المرتبطة لا تطابق تفاصيل المسير؛ أوقفنا العكس لحماية الأرصدة",409);
    for(const ar of repayments.rows){
     const repaymentLedger=await client.query(
      "SELECT employee_id,credit_amount,debit_amount FROM employee_earnings_ledger WHERE advance_repayment_id=$1 FOR UPDATE",[ar.id]);
     if(repaymentLedger.rowCount!==1||repaymentLedger.rows[0].employee_id!==ar.employee_id||
        Math.abs(Number(repaymentLedger.rows[0].credit_amount)-Number(ar.amount))>0.01||
        Number(repaymentLedger.rows[0].debit_amount)!==0)
      throw new AppError("REVERSAL_ADVANCE_LEDGER_MISMATCH","قيد أحد أقساط السلف غير موجود أو لا يطابق الموظف والمبلغ؛ أوقفنا العكس",409);
     const prior=await client.query(
      "SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",
      [ar.id]);
     const remaining=Number(ar.amount)-Number(prior.rows[0].amount);
     if(remaining<=0.0001||Math.abs(remaining-Number(ar.amount))>0.01)
      throw new AppError("ZERO_NET_ADVANCE_ALREADY_REVERSED","يوجد قسط سلفة مرتبط سبق عكسه أو عُكس جزئيًا؛ راجع التسوية قبل المتابعة",409);
     lines.push({source_type:"ADVANCE_REPAYMENT",source_id:ar.id,amount:remaining});
     advanceIds.add(ar.advance_id);
     ledgerMoves.push({employeeId:ar.employee_id,credit:0,debit:remaining,notes:"عكس سداد سلفة "+ar.code+" / "+ar.id});
    }
    lines.push({source_type:"ZERO_NET_PAYROLL_SETTLEMENT",source_id:item.id,amount:grossSalary});
    ledgerMoves.push({employeeId:item.employee_id,credit:grossSalary,debit:0,notes:"عكس تسوية راتب بصافي صفر "+item.id});
    zeroNetPayrollItemId=item.id;
   }else if(input.sourceType==="ADVANCE_REPAYMENT"){
    const q=await client.query(`SELECT ar.*,a.employee_id,a.code FROM advance_repayments ar
      JOIN advance_requests a ON a.id=ar.advance_id WHERE ar.id=$1 FOR UPDATE OF ar,a`,[input.sourceId]);
    if(!q.rowCount)throw new AppError("REVERSAL_SOURCE_NOT_FOUND","عملية سداد السلفة الأصلية غير موجودة",404);
    const ar=q.rows[0];
    if(ar.source_worker_payment_id)throw new AppError("WORKER_PAYMENT_REPAYMENT_REQUIRES_PAYMENT_REVERSAL","قسط السلفة المرتبط بدفعة عامل يُعكس بعكس دفعة العامل كاملة",409);
    if(ar.source_payroll_item_id||ar.source_payroll_payment_id)throw new AppError("PAYROLL_REPAYMENT_REQUIRES_PAYMENT_REVERSAL","قسط السلفة المسدد من الراتب يُعكس بعكس دفعة الراتب المرتبطة به",409);
    advanceIds.add(ar.advance_id);
    const prior=await client.query("SELECT COALESCE(SUM(amount),0) AS amount FROM financial_reversal_lines WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1",[input.sourceId]);
    if(input.amount>Number(ar.amount)-Number(prior.rows[0].amount)+0.0001)throw new AppError("REVERSAL_EXCEEDS_REMAINING","مبلغ العكس أكبر من المتبقي من عملية السداد",409);
    const ledger=await client.query("SELECT employee_id,credit_amount,debit_amount FROM employee_earnings_ledger WHERE advance_repayment_id=$1 FOR UPDATE",[input.sourceId]);
    if(!ledger.rowCount||ledger.rows[0].employee_id!==ar.employee_id||Math.abs(Number(ledger.rows[0].credit_amount)-Number(ar.amount))>0.01||Number(ledger.rows[0].debit_amount)!==0)
     throw new AppError("REVERSAL_LEDGER_MISMATCH","قيد سداد السلفة غير مطابق؛ أصلح المطابقة قبل العكس",409);
    const cash=await client.query("SELECT employee_id,amount FROM cash_custody_transactions WHERE source_type='ADVANCE_REPAYMENT' AND source_id=$1 AND direction='IN' FOR UPDATE",[input.sourceId]);
    if(cash.rowCount!==1||Math.abs(Number(cash.rows[0].amount)-Number(ar.amount))>0.01)throw new AppError("REVERSAL_CUSTODY_MISMATCH","إيصال العهدة الأصلي غير موجود أو غير مطابق؛ أصلح المطابقة قبل العكس",409);
    lines.push({source_type:"ADVANCE_REPAYMENT",source_id:input.sourceId,amount:input.amount});
    ledgerMoves.push({employeeId:ar.employee_id,credit:0,debit:input.amount,notes:"عكس سداد سلفة "+ar.code+" / "+input.sourceId});
    custodyMoves.push({employeeId:cash.rows[0].employee_id,direction:"OUT",amount:input.amount,description:"عكس تحصيل سداد سلفة "+ar.code});
   }else if(input.sourceType==="WORKER_SETTLEMENT_DIFFERENCE_EVENT"){
    const identity=await client.query(
     `SELECT d.employee_id FROM worker_payment_settlement_difference_events ev
        JOIN worker_payment_settlement_differences d ON d.id=ev.difference_id
       WHERE ev.id=$1`,[input.sourceId]);
    if(!identity.rowCount)throw new AppError("REVERSAL_SOURCE_NOT_FOUND","حركة فرق التسوية الأصلية غير موجودة",404);
    await client.query("SELECT id FROM employees WHERE id=$1 FOR UPDATE",[identity.rows[0].employee_id]);
    const eventResult=await client.query(
     `SELECT ev.*,d.employee_id,d.status AS difference_status,wp.created_at AS payment_created_at
        FROM worker_payment_settlement_difference_events ev
        JOIN worker_payment_settlement_differences d ON d.id=ev.difference_id
        JOIN worker_payments wp ON wp.id=ev.worker_payment_id
       WHERE ev.id=$1 FOR UPDATE OF ev,d`,[input.sourceId]);
    if(!eventResult.rowCount)throw new AppError("REVERSAL_SOURCE_NOT_FOUND","حركة فرق التسوية الأصلية غير موجودة",404);
    const event=eventResult.rows[0];
    if(!["ALLOCATED_TO_PRODUCTION","TRANSFERRED_TO_SOURCE_ORDER"].includes(event.event_type))
     throw new AppError("WORKER_DIFFERENCE_EVENT_NOT_REVERSIBLE","نوع الحركة لا يدعم العكس المستقل",409);
    if(event.difference_status==="REVERSED"||event.difference_status==="REQUIRES_REVIEW")
     throw new AppError("WORKER_DIFFERENCE_REQUIRES_REVIEW","فرق التسوية معكوس أو قيد المراجعة بالفعل",409);
    if(Math.abs(Number(event.amount)-input.amount)>0.01)
     throw new AppError("WORKER_DIFFERENCE_FULL_EVENT_REVERSAL_REQUIRED","عكس حدث فرق التسوية يتطلب عكس الحدث بالكامل",409);
    const parentReversal=await client.query(
     "SELECT 1 FROM financial_reversal_lines WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
     [event.worker_payment_id]);
    if(parentReversal.rowCount)
     throw new AppError("WORKER_PAYMENT_ALREADY_REVERSED","دفعة العامل الأصلية معكوسة بالفعل؛ لا يمكن عكس حدث تابع لها منفصلًا",409);
    const priorEventReversal=await client.query(
     "SELECT 1 FROM worker_payment_settlement_difference_events WHERE reverses_event_id=$1 AND event_type='REVERSED'",
     [event.id]);
    if(priorEventReversal.rowCount)
     throw new AppError("WORKER_DIFFERENCE_EVENT_ALREADY_REVERSED","حركة فرق التسوية سبق عكسها",409);
    if(event.event_type==="ALLOCATED_TO_PRODUCTION"){
     const allocation=await client.query(
      `SELECT id,worker_payment_id,production_entry_id,amount
         FROM worker_payment_order_allocations
        WHERE id=$1 FOR UPDATE`,[event.worker_payment_order_allocation_id]);
     if(allocation.rowCount!==1||allocation.rows[0].worker_payment_id!==event.worker_payment_id||
        allocation.rows[0].production_entry_id!==event.production_entry_id||
        Math.abs(Number(allocation.rows[0].amount)-Number(event.amount))>0.01)
      throw new AppError("WORKER_DIFFERENCE_ALLOCATION_MISMATCH","تخصيص الإنتاج المرتبط بفرق التسوية غير موجود أو غير مطابق",409);
     const priorAllocationReversal=await client.query(
      `SELECT 1 FROM worker_payment_allocation_reversals
        WHERE allocation_source='WORKER_PAYMENT_ORDER' AND source_allocation_id=$1`,
      [event.worker_payment_order_allocation_id]);
     if(priorAllocationReversal.rowCount)
      throw new AppError("WORKER_DIFFERENCE_ALLOCATION_ALREADY_REVERSED","تخصيص الإنتاج سبق عكسه؛ راجع سجل التسويات",409);
     const dependent=await client.query(
      `SELECT 1 FROM worker_payments later
        WHERE later.employee_id=$1 AND later.id<>$2
          AND later.created_at>(SELECT created_at FROM worker_payments WHERE id=$2)
          AND (
            EXISTS(SELECT 1 FROM worker_payment_order_allocations a WHERE a.worker_payment_id=later.id AND a.production_entry_id=$3)
            OR EXISTS(SELECT 1 FROM worker_payment_allocations a WHERE a.worker_payment_id=later.id AND a.production_entry_id=$3)
            OR EXISTS(SELECT 1 FROM employee_earnings_settlements es
              JOIN employee_earnings_settlement_allocations a ON a.settlement_id=es.id
              WHERE es.worker_payment_id=later.id AND a.production_entry_id=$3)
          ) LIMIT 1 FOR UPDATE OF later`,
      [event.employee_id,event.worker_payment_id,event.production_entry_id]);
     if(dependent.rowCount)
      throw new AppError("WORKER_PAYMENT_HAS_DEPENDENT_SETTLEMENT","توجد دفعة لاحقة تعتمد على سجل الإنتاج؛ أوقفنا عكس التخصيص لحماية تسلسل المستحقات",409);
     allocationReversals.push({workerPaymentId:event.worker_payment_id,source:"WORKER_PAYMENT_ORDER",
      sourceAllocationId:event.worker_payment_order_allocation_id,productionEntryId:event.production_entry_id,amount:Number(event.amount)});
    }
    lines.push({source_type:"WORKER_SETTLEMENT_DIFFERENCE_EVENT",source_id:event.id,amount:Number(event.amount)});
    settlementDifferenceEventReversal={event,differenceId:event.difference_id};
   }
   const header=await client.query("INSERT INTO financial_reversals(idempotency_key,request_fingerprint,reason,reversal_date,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",[input.idempotencyKey,requestFingerprint,input.reason,reversalDate,request.user!.userId]);
   for(const line of lines)await client.query("INSERT INTO financial_reversal_lines(reversal_id,source_type,source_id,amount) VALUES($1,$2,$3,$4)",[header.rows[0].id,line.source_type,line.source_id,line.amount]);
   if(settlementDifferenceEventReversal){
    const event=settlementDifferenceEventReversal.event;
    await client.query(
     `INSERT INTO worker_payment_settlement_difference_events(
       difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,target_order_id,
       target_order_stage_id,production_entry_id,worker_payment_order_allocation_id,reverses_event_id,
       financial_reversal_id,actor_type,actor_user_id,reason
      ) VALUES($1,$2,$3,'REVERSED',$4,$5,$6,$7,$8,$9,$10,$11,'USER',$12,$13)`,
     [event.difference_id,event.worker_payment_id,event.source_expense_id,event.amount,event.source_order_id,
      event.target_order_id,event.target_order_stage_id,event.production_entry_id,event.worker_payment_order_allocation_id,
      event.id,header.rows[0].id,request.user!.userId,"عكس مستقل لحدث فرق التسوية: "+input.reason]);
    await client.query(
     "UPDATE worker_payment_settlement_differences SET status='REQUIRES_REVIEW',updated_at=now() WHERE id=$1",
     [settlementDifferenceEventReversal.differenceId]);
   }
   for(const expense of expenseReversals)await client.query(
    `INSERT INTO accounting_expense_reversals(reversal_id,expense_id,source_worker_payment_id,amount,created_by)
     VALUES($1,$2,$3,$4,$5)`,
    [header.rows[0].id,expense.expenseId,expense.workerPaymentId,expense.amount,request.user!.userId]);
   const settlementDifferenceReversals:Array<{differenceId:string;eventId:string;amount:number}>=[];
   if(input.sourceType==="WORKER_PAYMENT"){
    const difference=await client.query("SELECT id FROM worker_payment_settlement_differences WHERE worker_payment_id=$1 FOR UPDATE",[input.sourceId]);
    if(difference.rowCount){
     const activeEvents=await client.query(`
       SELECT e.* FROM worker_payment_settlement_difference_events e
        WHERE e.difference_id=$1 AND e.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
          AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events r WHERE r.reverses_event_id=e.id AND r.event_type='REVERSED')
        ORDER BY e.created_at,e.id FOR UPDATE OF e`,[difference.rows[0].id]);
     for(const event of activeEvents.rows){
      // A difference allocation is stored in WORKER_PAYMENT_ORDER even when the
      // original payment's canonical allocations live in the settlement table.
      // Parent reversal must reverse that secondary allocation too.
      if(event.event_type==="ALLOCATED_TO_PRODUCTION"&&
         !allocationReversals.some(item=>item.source==="WORKER_PAYMENT_ORDER"&&
           item.sourceAllocationId===event.worker_payment_order_allocation_id)){
       const allocation=await client.query(
        `SELECT id,worker_payment_id,production_entry_id,amount
           FROM worker_payment_order_allocations WHERE id=$1 FOR UPDATE`,
        [event.worker_payment_order_allocation_id]);
       if(allocation.rowCount!==1||allocation.rows[0].worker_payment_id!==event.worker_payment_id||
          allocation.rows[0].production_entry_id!==event.production_entry_id||
          Math.abs(Number(allocation.rows[0].amount)-Number(event.amount))>0.01)
        throw new AppError("WORKER_DIFFERENCE_ALLOCATION_MISMATCH","تخصيص الإنتاج المرتبط بفرق التسوية غير موجود أو غير مطابق؛ أوقفنا عكس الدفعة",409);
       const priorAllocationReversal=await client.query(
        `SELECT 1 FROM worker_payment_allocation_reversals
          WHERE allocation_source='WORKER_PAYMENT_ORDER' AND source_allocation_id=$1`,
        [event.worker_payment_order_allocation_id]);
       if(priorAllocationReversal.rowCount)
        throw new AppError("WORKER_DIFFERENCE_ALLOCATION_ALREADY_REVERSED","تخصيص فرق التسوية سبق عكسه دون حدث عكس مطابق؛ أوقفنا عكس الدفعة للمراجعة",409);
       allocationReversals.push({workerPaymentId:event.worker_payment_id,source:"WORKER_PAYMENT_ORDER",
        sourceAllocationId:event.worker_payment_order_allocation_id,productionEntryId:event.production_entry_id,
        amount:Number(event.amount)});
      }
      await client.query(`
       INSERT INTO worker_payment_settlement_difference_events(
        difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,target_order_id,
        target_order_stage_id,production_entry_id,worker_payment_order_allocation_id,reverses_event_id,
        financial_reversal_id,actor_type,actor_user_id,reason
       ) VALUES($1,$2,$3,'REVERSED',$4,$5,$6,$7,$8,$9,$10,$11,'USER',$12,$13)`,
       [event.difference_id,event.worker_payment_id,event.source_expense_id,event.amount,event.source_order_id,
        event.target_order_id,event.target_order_stage_id,event.production_entry_id,event.worker_payment_order_allocation_id,
        event.id,header.rows[0].id,request.user!.userId,"عكس فرق التسوية ضمن عكس دفعة العامل"]);
      settlementDifferenceReversals.push({differenceId:event.difference_id,eventId:event.id,amount:Number(event.amount)});
     }
     await client.query("UPDATE worker_payment_settlement_differences SET status='REVERSED',updated_at=now() WHERE id=$1",[difference.rows[0].id]);
    }
   }
   for(const allocation of allocationReversals)await client.query(
    `INSERT INTO worker_payment_allocation_reversals(reversal_id,worker_payment_id,allocation_source,source_allocation_id,production_entry_id,amount,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [header.rows[0].id,allocation.workerPaymentId,allocation.source,allocation.sourceAllocationId,allocation.productionEntryId,allocation.amount,request.user!.userId]);
   for(const move of ledgerMoves)await client.query(`INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,debit_amount,created_by,notes,financial_reversal_id)
     VALUES($1,'ADJUSTMENT',$2,$3,$4,$5,$6)`,[move.employeeId,move.credit,move.debit,request.user!.userId,move.notes+" · "+header.rows[0].code,header.rows[0].id]);
   for(const move of custodyMoves)await client.query(`INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by)
     VALUES($1,$2,$3,$4,$5,$6,'FINANCIAL_REVERSAL',$7,$8)`,[move.employeeId,move.direction,move.amount,reversalDate,move.description,"سبب العكس: "+input.reason,header.rows[0].id,request.user!.userId]);
   for(const advanceId of advanceIds)await client.query(`UPDATE advance_requests a SET repayment_status=CASE WHEN a.amount<=COALESCE((
     SELECT SUM(ar.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='ADVANCE_REPAYMENT' AND rl.source_id=ar.id),0))
     FROM advance_repayments ar WHERE ar.advance_id=a.id),0)+0.0001 THEN 'SETTLED' ELSE 'OPEN' END,updated_at=now() WHERE a.id=$1`,[advanceId]);
   if(zeroNetPayrollItemId)await client.query("UPDATE payroll_items SET status='REVERSED' WHERE id=$1",[zeroNetPayrollItemId]);
   if(payrollItemId){
    const totals=await client.query(`SELECT i.net_amount,COALESCE((SELECT SUM(pp.amount) FROM payroll_payments pp WHERE pp.payroll_item_id=i.id),0)
      -COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl JOIN payroll_payments pp ON pp.id=rl.source_id
        WHERE rl.source_type='PAYROLL_PAYMENT' AND pp.payroll_item_id=i.id),0) AS effective_paid
      FROM payroll_items i WHERE i.id=$1`,[payrollItemId]);
    const paid=Number(totals.rows[0].effective_paid),net=Number(totals.rows[0].net_amount);
    await client.query("UPDATE payroll_items SET status=$1 WHERE id=$2",[net<=0.0001||paid>=net-0.0001?"PAID":paid>0.0001?"PARTIAL":"UNPAID",payrollItemId]);
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reverse",module:"finance",entityType:"financial_reversal",entityId:header.rows[0].id,afterData:header.rows[0],metadata:{lines,allocationReversals,expenseReversals,settlementDifferenceReversals,settlementDifferenceEventReversal:settlementDifferenceEventReversal?{eventId:settlementDifferenceEventReversal.event.id,differenceId:settlementDifferenceEventReversal.differenceId}:null,reason:input.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return {replayed:false,reversal:header.rows[0],lines};
  });
  return reply.code(result.replayed?200:201).send({data:{reversal:result.reversal,lines:result.lines}});
 });

 app.get("/api/accounting/worker-settlement-differences",{
  preHandler:[authenticateRequest,requirePermission("finance.worker_settlement_differences.view")]
 },async()=>{
  const result=await pool.query(`
   SELECT d.id,d.worker_payment_id,d.employee_id,emp.full_name AS employee_name,
          wp.code AS payment_code,wp.gross_amount AS payment_gross_amount,
          d.source_order_id,o.code AS source_order_code,o.order_name AS source_order_name,
          d.source_order_stage_id,st.name AS source_stage_name,
          d.source_expense_id,e.amount AS source_expense_amount,
          d.original_amount,d.payment_date,d.eligible_at,d.status,d.created_at,
          COALESCE(events.allocated_amount,0) AS allocated_amount,
          COALESCE(events.transferred_amount,0) AS transferred_amount,
          COALESCE(events.reversed_amount,0) AS reversed_amount,
          CASE WHEN d.status='REVERSED' THEN 0
               ELSE GREATEST(d.original_amount-COALESCE(events.allocated_amount,0)-COALESCE(events.transferred_amount,0),0)
          END AS remaining_amount
     FROM worker_payment_settlement_differences d
     JOIN worker_payments wp ON wp.id=d.worker_payment_id
     JOIN employees emp ON emp.id=d.employee_id
     JOIN production_orders o ON o.id=d.source_order_id
     LEFT JOIN order_stages os ON os.id=d.source_order_stage_id
     LEFT JOIN stages st ON st.id=os.stage_id
     JOIN accounting_expenses e ON e.id=d.source_expense_id
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(ev.amount) FILTER(WHERE ev.event_type='ALLOCATED_TO_PRODUCTION' AND NOT EXISTS(
           SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id
         )),0) AS allocated_amount,
         COALESCE(SUM(ev.amount) FILTER(WHERE ev.event_type='TRANSFERRED_TO_SOURCE_ORDER' AND NOT EXISTS(
           SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id
         )),0) AS transferred_amount,
         COALESCE(SUM(ev.amount) FILTER(WHERE ev.event_type='REVERSED'),0) AS reversed_amount
       FROM worker_payment_settlement_difference_events ev WHERE ev.difference_id=d.id
     ) events ON TRUE
    ORDER BY CASE d.status WHEN 'PENDING' THEN 1 WHEN 'PARTIALLY_ALLOCATED' THEN 2 ELSE 3 END,d.eligible_at,d.created_at DESC
  `);
  return {data:result.rows};
 });

 app.get("/api/accounting/worker-settlement-differences/:id/events",{
  preHandler:[authenticateRequest,requirePermission("finance.worker_settlement_differences.view")]
 },async(request)=>{
  const parsed=z.object({id:z.string().uuid()}).safeParse(request.params);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","معرف فرق التسوية غير صحيح",422);
  const result=await pool.query(`
   SELECT e.*,target.code AS target_order_code,target.order_name AS target_order_name,
          p.code AS production_code,st.name AS target_stage_name,u.username AS actor_username
     FROM worker_payment_settlement_difference_events e
     LEFT JOIN production_orders target ON target.id=e.target_order_id
     LEFT JOIN production_entries p ON p.id=e.production_entry_id
     LEFT JOIN order_stages os ON os.id=e.target_order_stage_id
     LEFT JOIN stages st ON st.id=os.stage_id
     LEFT JOIN users u ON u.id=e.actor_user_id
    WHERE e.difference_id=$1
    ORDER BY e.created_at,e.id
  `,[parsed.data.id]);
  return {data:result.rows};
 });

 app.post("/api/accounting/worker-settlement-differences/:id/release",{
  preHandler:[authenticateRequest,requirePermission("finance.worker_settlement_differences.manage")]
 },async(request,reply)=>{
  const releaseParams=request.params as {id:string};
  const releaseBody=request.body as {reason?:unknown;idempotencyKey?:unknown};
  const parsed=z.object({
   id:z.string().uuid(),
   reason:z.string().trim().min(2).max(500),
   idempotencyKey:z.string().uuid()
  }).safeParse({id:releaseParams.id,reason:releaseBody?.reason,idempotencyKey:releaseBody?.idempotencyKey});
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات إعادة اعتماد فرق التسوية غير صحيحة",422);
  const input=parsed.data;
  const result=await withTransaction(async client=>{
   const replay=await client.query(
    "SELECT ev.*,d.status AS difference_status FROM worker_payment_settlement_difference_events ev JOIN worker_payment_settlement_differences d ON d.id=ev.difference_id WHERE ev.idempotency_key=$1",
    [input.idempotencyKey]);
   if(replay.rowCount){
    if(replay.rows[0].difference_id!==input.id||replay.rows[0].event_type!=="RELEASED_AFTER_REVIEW"||
       replay.rows[0].reason!==input.reason)
     throw new AppError("IDEMPOTENCY_KEY_REUSED","مفتاح إعادة الاعتماد مستخدم لعملية مختلفة",409);
    return {replayed:true,event:replay.rows[0],status:replay.rows[0].difference_status};
   }
   const identity=await client.query(
    "SELECT employee_id FROM worker_payment_settlement_differences WHERE id=$1",[input.id]);
   if(!identity.rowCount)throw new AppError("WORKER_DIFFERENCE_NOT_FOUND","فرق التسوية غير موجود",404);
   await client.query("SELECT id FROM employees WHERE id=$1 FOR UPDATE",[identity.rows[0].employee_id]);
   const difference=await client.query(
    "SELECT * FROM worker_payment_settlement_differences WHERE id=$1 FOR UPDATE",[input.id]);
   if(!difference.rowCount)throw new AppError("WORKER_DIFFERENCE_NOT_FOUND","فرق التسوية غير موجود",404);
   if(difference.rows[0].status!=="REQUIRES_REVIEW")
    throw new AppError("WORKER_DIFFERENCE_NOT_ON_REVIEW","فرق التسوية ليس في حالة المراجعة المحاسبية",409);
   const reversal=await client.query(
    "SELECT 1 FROM financial_reversal_lines WHERE source_type='WORKER_PAYMENT' AND source_id=$1",
    [difference.rows[0].worker_payment_id]);
   if(reversal.rowCount)throw new AppError("WORKER_PAYMENT_ALREADY_REVERSED","دفعة العامل الأصلية معكوسة؛ لا يمكن إعادة تفعيل فرقها",409);
   const reversalDate=new Date().toISOString().slice(0,10);
   await assertAccountingPeriodOpen(client,reversalDate);
   const totals=await client.query(
    `SELECT
      COALESCE(SUM(e.amount) FILTER(WHERE e.event_type='ALLOCATED_TO_PRODUCTION'
       AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events r WHERE r.reverses_event_id=e.id)),0) AS allocated,
      COALESCE(SUM(e.amount) FILTER(WHERE e.event_type='TRANSFERRED_TO_SOURCE_ORDER'
       AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events r WHERE r.reverses_event_id=e.id)),0) AS transferred
     FROM worker_payment_settlement_difference_events e WHERE e.difference_id=$1`,
    [input.id]);
   const allocated=Number(totals.rows[0].allocated??0);
   const transferred=Number(totals.rows[0].transferred??0);
   const remaining=Math.round((Number(difference.rows[0].original_amount)-allocated-transferred)*100)/100;
   if(remaining<=0.009)
    throw new AppError("WORKER_DIFFERENCE_NO_REMAINING_BALANCE","لا يوجد رصيد متبقٍ لإعادة تفعيله؛ راجع سجل الحركات",409);
   const event=await client.query(
    `INSERT INTO worker_payment_settlement_difference_events(
      difference_id,worker_payment_id,source_expense_id,event_type,amount,source_order_id,target_order_id,
      actor_type,actor_user_id,reason,idempotency_key
     ) VALUES($1,$2,$3,'RELEASED_AFTER_REVIEW',$4,$5,$5,'USER',$6,$7,$8)
     RETURNING *`,
    [input.id,difference.rows[0].worker_payment_id,difference.rows[0].source_expense_id,remaining,
     difference.rows[0].source_order_id,request.user!.userId,input.reason,input.idempotencyKey]);
   const nextStatus=allocated>0.009?"PARTIALLY_ALLOCATED":"PENDING";
   await client.query(
    "UPDATE worker_payment_settlement_differences SET status=$1,updated_at=now() WHERE id=$2",
    [nextStatus,input.id]);
   await writeAudit(client,{
    actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,
    action:"release_worker_payment_settlement_difference_review",module:"finance",
    entityType:"worker_payment_settlement_difference",entityId:input.id,
    afterData:{status:nextStatus,remainingAmount:remaining,releaseEventId:event.rows[0].id,reason:input.reason},
    metadata:{workerPaymentId:difference.rows[0].worker_payment_id,allocated,transferred,remaining},
    ipAddress:request.ip,userAgent:request.headers["user-agent"]??null
   });
   return {replayed:false,event:event.rows[0],status:nextStatus};
  });
  return reply.code(result.replayed?200:201).send({data:result});
 });

 app.post("/api/accounting/worker-settlement-differences/process",{
  preHandler:[authenticateRequest,requirePermission("finance.worker_settlement_differences.manage")]
 },async(request,reply)=>{
  const result=await withTransaction(async client=>{
   const transferred=await processMaturedWorkerPaymentDifferences(client,{actorUserId:request.user!.userId,actorType:"USER"});
   return {transferred};
  });
  return reply.code(200).send({data:result});
 });

 app.get("/api/accounting/historical-expense-orders",{preHandler:[authenticateRequest,requirePermission("finance.expenses.create")]},async()=>{
  const result=await pool.query("SELECT id,code,order_name,status FROM production_orders WHERE status<>'CANCELLED' ORDER BY created_at DESC,id");
  return {data:result.rows};
 });

 const reconciliationHandler = async () => {
  // Read-only checks: findings are never repaired automatically and no balance is changed.
  const [missingExpenses,missingAdjustmentEntries,missingCashMovements,paymentIntegrity,advanceDeductionMismatch,missingAdvanceRepayments,expenseCustodyMismatch,advanceRepaymentCustodyMismatch,zeroNetPayrollSettlementMismatches,advanceRepaymentLedgerMismatches,workerPaymentReversalMismatches,workerDifferenceEventReversalMismatches] = await Promise.all([
   pool.query(`
    SELECT i.id AS payroll_item_id,i.employee_id,emp.full_name,p.period_month::text AS period_month,
           i.net_amount,i.advance_repayment_amount,
           (i.net_amount+i.advance_repayment_amount) AS expected_salary_expense,
           i.accounting_expense_id,e.amount AS expense_amount,e.category
      FROM payroll_items i
      JOIN payroll_periods p ON p.id=i.period_id
      JOIN employees emp ON emp.id=i.employee_id
      LEFT JOIN accounting_expenses e ON e.id=i.accounting_expense_id
     WHERE p.status IN ('APPROVED','CLOSED') AND (i.net_amount+i.advance_repayment_amount)>0
       AND (e.id IS NULL OR e.category IS DISTINCT FROM 'SALARIES'
            OR ROUND(e.amount::numeric,2)<>ROUND((i.net_amount+i.advance_repayment_amount)::numeric,2))
     ORDER BY p.period_month,emp.full_name`),
   pool.query(`
    SELECT l.id AS adjustment_line_id,l.payroll_item_id,i.employee_id,emp.full_name,
           p.period_month::text AS period_month,l.line_type,l.description,l.amount,
           el.id AS ledger_entry_id,el.employee_id AS ledger_employee_id,
           el.credit_amount,el.debit_amount
      FROM payroll_adjustment_lines l
      JOIN payroll_items i ON i.id=l.payroll_item_id
      JOIN payroll_periods p ON p.id=i.period_id
      JOIN employees emp ON emp.id=i.employee_id
      LEFT JOIN employee_earnings_ledger el ON el.payroll_adjustment_line_id=l.id
     WHERE p.status IN ('APPROVED','CLOSED') AND l.status='ACTIVE'
       AND (
         el.id IS NULL
         OR el.employee_id IS DISTINCT FROM i.employee_id
         OR (l.line_type='BONUS' AND (
              ROUND(el.credit_amount::numeric,2)<>ROUND(l.amount::numeric,2)
              OR el.debit_amount<>0
            ))
         OR (l.line_type='DEDUCTION' AND (
              ROUND(el.debit_amount::numeric,2)<>ROUND(l.amount::numeric,2)
              OR el.credit_amount<>0
            ))
       )
     ORDER BY p.period_month,emp.full_name,l.created_at,l.id`),
   pool.query(`
    SELECT pp.id AS payment_id,pp.payroll_item_id,i.employee_id,emp.full_name,
           p.period_month::text AS period_month,pp.payment_date::text AS payment_date,
           pp.amount,pp.reference,custody.out_count AS custody_out_count,
           custody.out_amount AS custody_out_amount,
           offsets.offset_count AS custody_offset_count,
           offsets.offset_amount AS custody_offset_amount
      FROM payroll_payments pp
      JOIN payroll_items i ON i.id=pp.payroll_item_id
      JOIN payroll_periods p ON p.id=i.period_id
      JOIN employees emp ON emp.id=i.employee_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS out_count,
               COALESCE(SUM(c.amount),0) AS out_amount,
               COUNT(DISTINCT c.employee_id)::int AS out_holder_count,
               MIN(c.employee_id::text) AS out_holder_id
          FROM cash_custody_transactions c
         WHERE c.source_type='PAYROLL_PAYMENT' AND c.source_id=pp.id AND c.direction='OUT'
      ) custody ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS offset_count,
               COALESCE(SUM(ci.amount),0) AS offset_amount,
               COUNT(DISTINCT ci.employee_id)::int AS offset_holder_count,
               MIN(ci.employee_id::text) AS offset_holder_id
          FROM cash_custody_transactions ci
         WHERE ci.source_type='PAYROLL_ADVANCE_REPAYMENT_OFFSET'
           AND ci.source_id=pp.id AND ci.direction='IN'
      ) offsets ON TRUE
     WHERE UPPER(COALESCE(pp.payment_method,''))='CASH'
       AND COALESCE(pp.settlement_source,'CURRENT_CUSTODY')<>'PREVIOUS_CUSTODY'
       AND (
         custody.out_count<>1
         OR ROUND(custody.out_amount::numeric,2) <>
            ROUND((pp.amount+offsets.offset_amount)::numeric,2)
         OR offsets.offset_count <> CASE WHEN offsets.offset_amount>0 THEN 1 ELSE 0 END
         OR (offsets.offset_amount>0 AND (
              offsets.offset_holder_count<>1
              OR custody.out_holder_count<>1
              OR offsets.offset_holder_id IS DISTINCT FROM custody.out_holder_id
            ))
       )
     ORDER BY pp.payment_date,emp.full_name`),
   pool.query(`
    SELECT i.id AS payroll_item_id,emp.full_name,p.period_month::text AS period_month,
           i.status,i.net_amount,COALESCE(SUM(pp.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='PAYROLL_PAYMENT' AND rl.source_id=pp.id),0)),0) AS paid_amount
      FROM payroll_items i
      JOIN payroll_periods p ON p.id=i.period_id
      JOIN employees emp ON emp.id=i.employee_id
      LEFT JOIN payroll_payments pp ON pp.payroll_item_id=i.id
     WHERE p.status IN ('APPROVED','CLOSED')
     GROUP BY i.id,emp.full_name,p.period_month
    HAVING COALESCE(SUM(pp.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='PAYROLL_PAYMENT' AND rl.source_id=pp.id),0)),0)>i.net_amount+0.01
        OR (i.status='PAID' AND COALESCE(SUM(pp.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='PAYROLL_PAYMENT' AND rl.source_id=pp.id),0)),0)<i.net_amount-0.01)
        OR (i.status='PARTIAL' AND (COALESCE(SUM(pp.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='PAYROLL_PAYMENT' AND rl.source_id=pp.id),0)),0)<=0.01 OR COALESCE(SUM(pp.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='PAYROLL_PAYMENT' AND rl.source_id=pp.id),0)),0)>=i.net_amount-0.01))
        OR (i.status='UNPAID' AND COALESCE(SUM(pp.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='PAYROLL_PAYMENT' AND rl.source_id=pp.id),0)),0)>0.01)
     ORDER BY p.period_month,emp.full_name`),
   pool.query(`
    SELECT i.id AS payroll_item_id,emp.full_name,p.period_month::text AS period_month,
           i.advance_repayment_amount,COALESCE(SUM(d.amount),0) AS allocated_amount
      FROM payroll_items i
      JOIN payroll_periods p ON p.id=i.period_id
      JOIN employees emp ON emp.id=i.employee_id
      LEFT JOIN payroll_advance_deductions d ON d.payroll_item_id=i.id
     WHERE p.status IN ('APPROVED','CLOSED')
     GROUP BY i.id,emp.full_name,p.period_month
    HAVING ROUND(COALESCE(SUM(d.amount),0)::numeric,2)<>ROUND(i.advance_repayment_amount::numeric,2)
     ORDER BY p.period_month,emp.full_name`),
   pool.query(`
    SELECT i.id AS payroll_item_id,emp.full_name,p.period_month::text AS period_month,
           a.id AS advance_id,a.code AS advance_code,d.amount
      FROM payroll_items i
      JOIN payroll_periods p ON p.id=i.period_id
      JOIN employees emp ON emp.id=i.employee_id
      JOIN payroll_advance_deductions d ON d.payroll_item_id=i.id
      JOIN advance_requests a ON a.id=d.advance_id
      LEFT JOIN advance_repayments ar
        ON ar.advance_id=d.advance_id AND ar.source_payroll_item_id=i.id
     WHERE p.status IN ('APPROVED','CLOSED') AND i.status='PAID' AND ar.id IS NULL
     ORDER BY p.period_month,emp.full_name,a.code`),
   pool.query(`
    SELECT e.id AS expense_id,e.description,e.amount,e.expense_date::text AS expense_date,
           e.paid_from_employee_id,emp.full_name AS employee_name,
           e.cash_custody_transaction_id,linked.id AS matched_custody_id,
           movements.movement_count AS custody_movement_count,
           movements.movement_amount AS custody_amount,
           movements.holder_id AS custody_employee_id
      FROM accounting_expenses e
      LEFT JOIN employees emp ON emp.id=e.paid_from_employee_id
      LEFT JOIN worker_payments wp
        ON e.category='WORKER_PAYMENT' AND wp.idempotency_key=e.idempotency_key
      LEFT JOIN cash_custody_transactions linked
        ON linked.id=e.cash_custody_transaction_id
       AND linked.direction='OUT'
       AND (
         (linked.source_type='ACCOUNTING_EXPENSE' AND linked.source_id=e.id)
         OR (e.category='WORKER_PAYMENT' AND linked.source_type='WORKER_PAYMENT' AND linked.source_id=wp.id)
       )
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS movement_count,
               COALESCE(SUM(c.amount),0) AS movement_amount,
               COUNT(DISTINCT c.employee_id)::int AS holder_count,
               MIN(c.employee_id::text) AS holder_id
          FROM cash_custody_transactions c
         WHERE c.direction='OUT'
           AND (
             (c.source_type='ACCOUNTING_EXPENSE' AND c.source_id=e.id)
             OR (e.category='WORKER_PAYMENT' AND c.source_type='WORKER_PAYMENT' AND c.source_id=wp.id)
           )
      ) movements ON TRUE
     WHERE e.paid_from_employee_id IS NOT NULL
       AND (linked.id IS NULL OR movements.movement_count<>1
            OR movements.holder_count<>1
            OR movements.holder_id IS DISTINCT FROM e.paid_from_employee_id::text
            OR ROUND(movements.movement_amount::numeric,2)<>ROUND(COALESCE(wp.amount,e.amount)::numeric,2))
     ORDER BY e.expense_date DESC,e.created_at DESC`),
   pool.query(`
    SELECT ar.id AS repayment_id,ar.advance_id,a.code AS advance_code,
           a.employee_id,emp.full_name AS employee_name,
           creator.employee_id AS expected_custody_holder_id,
           ar.amount,ar.payment_date::text AS payment_date,
           movements.movement_count AS custody_movement_count,
           movements.movement_amount AS custody_amount,
           movements.holder_count AS custody_holder_count,
           movements.holder_id AS custody_holder_id
      FROM advance_repayments ar
      JOIN advance_requests a ON a.id=ar.advance_id
      JOIN employees emp ON emp.id=a.employee_id
      LEFT JOIN users creator ON creator.id=ar.created_by
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS movement_count,
               COALESCE(SUM(c.amount),0) AS movement_amount,
               COUNT(DISTINCT c.employee_id)::int AS holder_count,
               MIN(c.employee_id::text) AS holder_id
          FROM cash_custody_transactions c
         WHERE c.source_type='ADVANCE_REPAYMENT'
           AND c.source_id=ar.id AND c.direction='IN'
      ) movements ON TRUE
     WHERE ar.source_payroll_item_id IS NULL
       AND (movements.movement_count<>1
            OR movements.holder_count<>1
            OR movements.holder_id IS DISTINCT FROM creator.employee_id::text
            OR ROUND(movements.movement_amount::numeric,2)<>ROUND(ar.amount::numeric,2))
     ORDER BY ar.payment_date DESC,emp.full_name`),
   pool.query(`
    SELECT i.id AS payroll_item_id,emp.full_name,p.period_month::text AS period_month,
           i.base_salary,i.bonus_amount,i.deduction_amount,i.advance_repayment_amount,
           (i.base_salary+i.bonus_amount-i.deduction_amount) AS expected_offset,
           offset_entry.id AS ledger_entry_id,offset_entry.employee_id AS ledger_employee_id,
           offset_entry.debit_amount,offset_entry.credit_amount,
           COALESCE(repayments.amount,0) AS committed_repayments
      FROM payroll_items i
      JOIN payroll_periods p ON p.id=i.period_id
      JOIN employees emp ON emp.id=i.employee_id
      LEFT JOIN employee_earnings_ledger offset_entry
        ON offset_entry.payroll_advance_offset_item_id=i.id
      LEFT JOIN LATERAL (
        SELECT SUM(ar.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='ADVANCE_REPAYMENT' AND rl.source_id=ar.id),0)) AS amount
          FROM advance_repayments ar
         WHERE ar.source_payroll_item_id=i.id
      ) repayments ON TRUE
     WHERE p.status IN ('APPROVED','CLOSED')
       AND i.status='PAID' AND i.net_amount<=0.01 AND i.advance_repayment_amount>0.01
       AND (
         ROUND(COALESCE(repayments.amount,0)::numeric,2)<>ROUND(i.advance_repayment_amount::numeric,2)
         OR offset_entry.id IS NULL
         OR offset_entry.employee_id IS DISTINCT FROM i.employee_id
         OR ROUND(offset_entry.debit_amount::numeric,2)<>ROUND((i.base_salary+i.bonus_amount-i.deduction_amount)::numeric,2)
         OR offset_entry.credit_amount<>0
       )
     ORDER BY p.period_month,emp.full_name`),
   pool.query(`
    SELECT ar.id AS repayment_id,ar.source_payroll_item_id AS payroll_item_id,
           emp.full_name,COALESCE(p.period_month::text,'سداد يدوي') AS period_month,
           a.code AS advance_code,COALESCE(d.amount,ar.amount) AS expected_repayment_amount,
           ar.amount AS repayment_amount,el.id AS ledger_entry_id,
           el.employee_id AS ledger_employee_id,el.credit_amount,el.debit_amount
      FROM advance_repayments ar
      JOIN advance_requests a ON a.id=ar.advance_id
      JOIN employees emp ON emp.id=a.employee_id
      LEFT JOIN payroll_items i ON i.id=ar.source_payroll_item_id
      LEFT JOIN payroll_periods p ON p.id=i.period_id
      LEFT JOIN payroll_advance_deductions d
        ON d.payroll_item_id=ar.source_payroll_item_id AND d.advance_id=ar.advance_id
      LEFT JOIN employee_earnings_ledger el
        ON el.advance_repayment_id=ar.id
     WHERE (
       el.id IS NULL
       OR el.employee_id IS DISTINCT FROM a.employee_id
       OR ROUND(el.credit_amount::numeric,2)<>ROUND(ar.amount::numeric,2)
       OR el.debit_amount<>0
       OR (ar.source_payroll_item_id IS NOT NULL AND (
         i.id IS NULL OR i.status NOT IN ('PAID','REVERSED')
         OR i.employee_id IS DISTINCT FROM a.employee_id
         OR d.id IS NULL
         OR ROUND(d.amount::numeric,2)<>ROUND(ar.amount::numeric,2)
       ))
     )
     ORDER BY ar.payment_date,emp.full_name,a.code`),
   pool.query(`
    SELECT wp.id AS worker_payment_id,wp.employee_id,wp.gross_amount,wp.amount AS cash_paid_amount,
           wp.advance_repayment_amount,r.id AS reversal_id,
           COALESCE(ledger.credit_total,0) AS ledger_credit,
           COALESCE(ledger.debit_total,0) AS ledger_debit,
           COALESCE(ledger.wrong_employee_count,0) AS wrong_ledger_employee_count,
           COALESCE(expenses.source_total,0) AS source_expense_total,
           COALESCE(expenses.reversed_total,0) AS reversed_expense_total,
           COALESCE(expenses.source_count,0) AS source_expense_count,
           COALESCE(expenses.reversed_count,0) AS reversed_expense_count,
           COALESCE(expenses.missing_count,0) AS missing_expense_reversals,
           COALESCE(custody.original_out,0) AS original_custody_out,
           COALESCE(custody.reversal_in,0) AS reversal_custody_in,
           COALESCE(allocations.source_count,0) AS source_allocation_count,
           COALESCE(allocations.reversed_count,0) AS reversed_allocation_count,
           COALESCE(allocations.source_amount,0) AS source_allocation_amount,
           COALESCE(allocations.reversed_amount,0) AS reversed_allocation_amount,
           COALESCE(allocations.missing_count,0) AS missing_allocation_reversals,
           COALESCE(difference_events.active_count,0) AS active_difference_events
      FROM financial_reversal_lines line
      JOIN financial_reversals r ON r.id=line.reversal_id
      JOIN worker_payments wp ON wp.id=line.source_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(l.credit_amount),0) AS credit_total,
               COALESCE(SUM(l.debit_amount),0) AS debit_total,
               COUNT(*) FILTER(WHERE l.employee_id<>wp.employee_id)::int AS wrong_employee_count
          FROM employee_earnings_ledger l WHERE l.financial_reversal_id=r.id
      ) ledger ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(e.amount),0) AS source_total,COUNT(*)::int AS source_count,
               COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.reversal_id=r.id),0) AS reversed_total,
               (SELECT COUNT(*)::int FROM accounting_expense_reversals er WHERE er.reversal_id=r.id) AS reversed_count,
               COUNT(*) FILTER(WHERE NOT EXISTS(
                 SELECT 1 FROM accounting_expense_reversals er
                  WHERE er.reversal_id=r.id AND er.expense_id=e.id AND er.source_worker_payment_id=wp.id AND ABS(er.amount-e.amount)<=0.0001
               ))::int AS missing_count
          FROM accounting_expenses e
         WHERE e.source_worker_payment_id=wp.id
            OR (e.source_worker_payment_id IS NULL AND e.idempotency_key=wp.idempotency_key)
      ) expenses ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE((SELECT SUM(c.amount) FROM cash_custody_transactions c WHERE c.source_type='WORKER_PAYMENT' AND c.source_id=wp.id AND c.direction='OUT'),0) AS original_out,
               COALESCE((SELECT SUM(c.amount) FROM cash_custody_transactions c WHERE c.source_type='FINANCIAL_REVERSAL' AND c.source_id=r.id AND c.direction='IN'),0) AS reversal_in
      ) custody ON TRUE
      LEFT JOIN LATERAL (
        WITH source_allocations AS (
          SELECT a.id,a.amount,a.production_entry_id,'EMPLOYEE_EARNINGS_SETTLEMENT'::text AS source
            FROM employee_earnings_settlement_allocations a
            JOIN employee_earnings_settlements es ON es.id=a.settlement_id
           WHERE es.worker_payment_id=wp.id
          UNION ALL
          SELECT a.id,a.amount,a.production_entry_id,'WORKER_PAYMENT_ORDER'::text
            FROM worker_payment_order_allocations a
           WHERE a.worker_payment_id=wp.id
             AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id WHERE es.worker_payment_id=wp.id)
          UNION ALL
          -- Difference allocations are stored in WORKER_PAYMENT_ORDER even when
          -- the parent payment's canonical production allocations use settlements.
          -- Include only event-backed rows in that mixed-source case so the
          -- reversal reconciliation compares like-for-like source allocations.
          SELECT a.id,a.amount,a.production_entry_id,'WORKER_PAYMENT_ORDER'::text
            FROM worker_payment_order_allocations a
            JOIN worker_payment_settlement_difference_events de
              ON de.worker_payment_order_allocation_id=a.id
             AND de.event_type='ALLOCATED_TO_PRODUCTION'
           WHERE a.worker_payment_id=wp.id
             AND EXISTS(SELECT 1 FROM employee_earnings_settlements es
               JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id
               WHERE es.worker_payment_id=wp.id)
          UNION ALL
          SELECT a.id,a.amount,a.production_entry_id,'WORKER_PAYMENT_LEGACY'::text
            FROM worker_payment_allocations a
           WHERE a.worker_payment_id=wp.id
             AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id WHERE es.worker_payment_id=wp.id)
             AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
        )
        SELECT COUNT(*)::int AS source_count,COALESCE(SUM(sa.amount),0) AS source_amount,
               (SELECT COUNT(*)::int FROM worker_payment_allocation_reversals wa WHERE wa.worker_payment_id=wp.id) AS reversed_count,
               (SELECT COALESCE(SUM(wa.amount),0) FROM worker_payment_allocation_reversals wa WHERE wa.worker_payment_id=wp.id) AS reversed_amount,
               COUNT(*) FILTER(WHERE NOT EXISTS(
                 SELECT 1 FROM worker_payment_allocation_reversals wa
                  WHERE wa.worker_payment_id=wp.id AND wa.source_allocation_id=sa.id AND wa.allocation_source=sa.source
                    AND wa.production_entry_id=sa.production_entry_id AND ABS(wa.amount-sa.amount)<=0.0001
               ))::int AS missing_count
          FROM source_allocations sa
      ) allocations ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS active_count
          FROM worker_payment_settlement_differences d
          JOIN worker_payment_settlement_difference_events e ON e.difference_id=d.id
         WHERE d.worker_payment_id=wp.id
           AND e.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
           AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=e.id)
      ) difference_events ON TRUE
     WHERE line.source_type='WORKER_PAYMENT'
       AND (
         ABS(COALESCE(ledger.credit_total,0)-wp.gross_amount)>0.01
         OR ABS(COALESCE(ledger.debit_total,0)-wp.advance_repayment_amount)>0.01
         OR COALESCE(ledger.wrong_employee_count,0)>0
         OR ABS(COALESCE(expenses.source_total,0)-wp.gross_amount)>0.01
         OR ABS(COALESCE(expenses.reversed_total,0)-wp.gross_amount)>0.01
         OR COALESCE(expenses.source_count,0)<>COALESCE(expenses.reversed_count,0)
         OR COALESCE(expenses.missing_count,0)>0
         OR ABS(COALESCE(custody.original_out,0)-COALESCE(custody.reversal_in,0))>0.01
         OR COALESCE(allocations.source_count,0)<>COALESCE(allocations.reversed_count,0)
         OR ABS(COALESCE(allocations.source_amount,0)-COALESCE(allocations.reversed_amount,0))>0.01
         OR COALESCE(allocations.missing_count,0)>0
         OR COALESCE(difference_events.active_count,0)>0
       )
     ORDER BY r.created_at DESC,wp.created_at DESC`),
   pool.query(`
    SELECT 'MISSING_OR_MISMATCHED_REVERSAL_EVENT'::text AS issue_type,
           line.source_id AS source_event_id,line.reversal_id,
           line.amount AS journal_amount,original.amount AS original_amount,
           reversed.id AS reversal_event_id,reversed.amount AS reversal_event_amount
      FROM financial_reversal_lines line
      LEFT JOIN worker_payment_settlement_difference_events original
        ON original.id=line.source_id
      LEFT JOIN worker_payment_settlement_difference_events reversed
        ON reversed.reverses_event_id=original.id AND reversed.event_type='REVERSED'
     WHERE line.source_type='WORKER_SETTLEMENT_DIFFERENCE_EVENT'
       AND (
         original.id IS NULL
         OR original.event_type NOT IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
         OR ABS(line.amount-original.amount)>0.01
         OR reversed.id IS NULL
         OR reversed.financial_reversal_id IS DISTINCT FROM line.reversal_id
         OR ABS(reversed.amount-line.amount)>0.01
         OR reversed.difference_id IS DISTINCT FROM original.difference_id
         OR reversed.worker_payment_id IS DISTINCT FROM original.worker_payment_id
       )
    UNION ALL
    SELECT 'MISSING_REVERSAL_JOURNAL_LINE'::text AS issue_type,
           reversed.reverses_event_id AS source_event_id,reversed.financial_reversal_id AS reversal_id,
           NULL::numeric AS journal_amount,original.amount AS original_amount,
           reversed.id AS reversal_event_id,reversed.amount AS reversal_event_amount
      FROM worker_payment_settlement_difference_events reversed
      LEFT JOIN worker_payment_settlement_difference_events original
        ON original.id=reversed.reverses_event_id
     WHERE reversed.event_type='REVERSED'
       AND (
         original.id IS NULL
         OR original.difference_id IS DISTINCT FROM reversed.difference_id
         OR original.worker_payment_id IS DISTINCT FROM reversed.worker_payment_id
         OR ABS(original.amount-reversed.amount)>0.01
         OR NOT EXISTS(
           SELECT 1 FROM financial_reversal_lines line
            WHERE line.reversal_id=reversed.financial_reversal_id
              AND (
                (line.source_type='WORKER_SETTLEMENT_DIFFERENCE_EVENT'
                  AND line.source_id=reversed.reverses_event_id
                  AND ABS(line.amount-reversed.amount)<=0.01)
                OR
                (line.source_type='WORKER_PAYMENT'
                  AND line.source_id=reversed.worker_payment_id)
              )
         )
       )
     ORDER BY reversal_id,source_event_id
   `)
  ]);
  return {
   checkedAt:new Date().toISOString(),
   counts:{
    missingPayrollExpenses:missingExpenses.rows.length,
    missingAdjustmentLedgerEntries:missingAdjustmentEntries.rows.length,
    cashPaymentsMissingCustodyOut:missingCashMovements.rows.length,
    payrollPaymentMismatches:paymentIntegrity.rows.length,
    advanceDeductionMismatches:advanceDeductionMismatch.rows.length,
    paidPayrollMissingAdvanceRepayments:missingAdvanceRepayments.rows.length,
    expensesMissingCustodyLink:expenseCustodyMismatch.rows.length,
    advanceRepaymentsMissingCustodyIn:advanceRepaymentCustodyMismatch.rows.length,
    zeroNetPayrollSettlementMismatches:zeroNetPayrollSettlementMismatches.rows.length,
    advanceRepaymentLedgerMismatches:advanceRepaymentLedgerMismatches.rows.length,
    workerPaymentReversalMismatches:workerPaymentReversalMismatches.rows.length,
    workerDifferenceEventReversalMismatches:workerDifferenceEventReversalMismatches.rows.length
   },
   issues:{
    missingPayrollExpenses:missingExpenses.rows,
    missingAdjustmentLedgerEntries:missingAdjustmentEntries.rows,
    cashPaymentsMissingCustodyOut:missingCashMovements.rows,
    payrollPaymentMismatches:paymentIntegrity.rows,
    advanceDeductionMismatches:advanceDeductionMismatch.rows,
    paidPayrollMissingAdvanceRepayments:missingAdvanceRepayments.rows,
    expensesMissingCustodyLink:expenseCustodyMismatch.rows,
    advanceRepaymentsMissingCustodyIn:advanceRepaymentCustodyMismatch.rows,
    zeroNetPayrollSettlementMismatches:zeroNetPayrollSettlementMismatches.rows,
    advanceRepaymentLedgerMismatches:advanceRepaymentLedgerMismatches.rows,
    workerPaymentReversalMismatches:workerPaymentReversalMismatches.rows,
    workerDifferenceEventReversalMismatches:workerDifferenceEventReversalMismatches.rows
   }
  };
 };
 app.get("/api/accounting/reconciliation/payroll",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view")]},async()=>({data:await reconciliationHandler()}));
 app.get("/api/accounting/reconciliation/overview",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view")]},async()=>({data:await reconciliationHandler()}));

 app.get("/api/accounting/expenses",{preHandler:[authenticateRequest,requirePermission("finance.expenses.view")]},async(request)=>{
  const q=z.object({orderId:z.string().uuid().optional()}).safeParse(request.query);
  if(!q.success)throw new AppError("VALIDATION_ERROR","فلتر المصروفات غير صحيح",422);
  const params:unknown[]=[];let where="";
  if(q.data.orderId){params.push(q.data.orderId);where=" WHERE e.order_id=$1 ";}
  const r=await pool.query(`SELECT e.*,
    COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0) AS reversed_amount,
    COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
      WHERE ev.source_expense_id=e.id AND ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
        AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)),0) AS difference_allocated_amount,
    GREATEST(e.amount
      -COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)
      -COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
        WHERE ev.source_expense_id=e.id AND ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
          AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)),0),0) AS effective_amount,
    o.code AS order_code,o.order_name,os.sequence_no AS stage_sequence_no,st.name AS stage_name,u.username AS created_by_username
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
    paymentMethod:p.data.paymentMethod??null,expenseType:p.data.expenseType,paidFromEmployeeId:p.data.paidFromEmployeeId??null,historicalSettlement:p.data.historicalSettlement
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
    if(order.rows[0].status==="COMPLETED"&&!p.data.historicalSettlement)throw new AppError("ORDER_NOT_EXPENSABLE","لا يمكن تسجيل مصروف جديد على طلبية مكتملة؛ أعد فتحها أولًا. يمكن للمحاسب تسجيل تسوية تاريخية موثقة فقط.",409);
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
   await assertAccountingDateOpen(client,p.data.expenseDate,p.data.historicalSettlement);
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
      COALESCE((SELECT SUM(e.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)) FROM accounting_expenses e),0) AS total_out,
      COALESCE((SELECT SUM(amount) FROM order_revenues WHERE UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'),0)-COALESCE((SELECT SUM(e.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)) FROM accounting_expenses e),0) AS net,
      COALESCE((SELECT COUNT(*) FROM order_revenues WHERE UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'),0)::int AS revenue_count,
      COALESCE((SELECT COUNT(*) FROM accounting_expenses),0)::int AS expense_count,
      COALESCE((SELECT SUM(GREATEST(e.amount
    -COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)
    -COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
      WHERE ev.source_expense_id=e.id AND ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
        AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)),0),0))
    FROM accounting_expenses e WHERE e.order_id IS NULL),0) AS general_expenses,
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
   // Carry opening balances only from the immediately preceding day; a closed period separated by a gap must not seed a later period.
   const previous=await client.query("SELECT p.id,s.report FROM accounting_periods p JOIN accounting_period_close_snapshots s ON s.period_id=p.id WHERE p.status='CLOSED' AND p.period_end=($1::date - INTERVAL '1 day')::date ORDER BY s.snapshot_no DESC LIMIT 1 FOR SHARE OF p",[p.data.periodStart]);
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
    -- Worker-payment expenses are already represented by approved production labor.
    -- Keep them out of the allocation basis and add only matured difference transfers,
    -- which are reclassified as direct order costs by the profitability reports.
    COALESCE((SELECT SUM(e.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0))
      FROM accounting_expenses e
     WHERE e.order_id=o.id AND e.expense_type='DIRECT' AND e.category IS DISTINCT FROM 'WORKER_PAYMENT'),0)
    +COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
      WHERE ev.target_order_id=o.id AND ev.event_type='TRANSFERRED_TO_SOURCE_ORDER'
        AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)),0)
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
    const centsRemaining=amountMinor-shares.reduce((sum,value)=>sum+value,0);
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

 app.post("/api/accounting/periods/:id/return-for-corrections",{preHandler:[authenticateRequest,requirePermission("finance.period_close.review")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const p=z.object({reason:z.string().trim().min(10).max(1000)}).safeParse(request.body);
  if(!p.success)throw new AppError("CORRECTION_REASON_REQUIRED","يجب توثيق سبب إعادة الفترة للتعديل",422);
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(!["UNDER_REVIEW","READY_FOR_APPROVAL"].includes(period.rows[0].status))throw new AppError("ACCOUNTING_PERIOD_STATE_INVALID","يمكن إعادة الفترة للتعديل أثناء المراجعة أو قبل اعتماد المدير فقط",409);
   const before=period.rows[0];
   const r=await client.query("UPDATE accounting_periods SET status='OPEN',reviewed_by=NULL,reviewed_at=NULL,approved_by=NULL,approved_at=NULL,notes=concat_ws(E'\\n',NULLIF(notes,''),'إعادة للتعديل: ' || $2) WHERE id=$1 RETURNING *",[id,p.data.reason]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"return_for_corrections",module:"finance",entityType:"accounting_period",entityId:id,beforeData:before,afterData:{...r.rows[0],correctionReason:p.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  })};
 });
 app.post("/api/accounting/periods/:id/approve-review",{preHandler:[authenticateRequest,requirePermission("finance.period_close.review")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if (!period.rowCount) throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
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
   if(!period.rows[0])throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="READY_FOR_APPROVAL")throw new AppError("ACCOUNTING_PERIOD_NOT_APPROVED","يجب اعتماد المراجعة المحاسبية قبل الإقفال النهائي",409);
   if(period.rows[0].reviewed_by===request.user!.userId)throw new AppError("SEPARATION_OF_DUTIES_REQUIRED","يجب أن يكون اعتماد الإقفال النهائي بواسطة مستخدم مختلف عن مراجع الفترة",409);
   // Lock the immediately following period before closing this one. A
   // contiguous period already under review or closed has frozen opening
   // balances and cannot safely be refreshed from this close snapshot.
   const followingPeriod=await client.query(
    "SELECT id,name,status FROM accounting_periods WHERE period_start=($1::date + INTERVAL '1 day')::date ORDER BY period_start LIMIT 1 FOR UPDATE",
    [period.rows[0].period_end]
   );
   if(followingPeriod.rowCount && followingPeriod.rows[0].status!=="OPEN")throw new AppError("NEXT_ACCOUNTING_PERIOD_LOCKED","لا يمكن إقفال الفترة قبل الفترة التالية مباشرة إذا كانت قيد المراجعة أو مقفولة؛ أكمل التصفية بالترتيب الزمني",409);
   const expenses=await client.query("SELECT e.id,e.amount,COALESCE(SUM(a.amount),0) AS allocated FROM accounting_expense_allocations a RIGHT JOIN accounting_expenses e ON e.id=a.expense_id AND a.period_id=$3 WHERE e.expense_type='ADMINISTRATIVE' AND e.expense_date BETWEEN $1 AND $2 GROUP BY e.id,e.amount",[period.rows[0].period_start,period.rows[0].period_end,id]);
   if(expenses.rows.some(e=>!hasCentPrecision(e.amount)))throw new AppError("EXPENSE_PRECISION_UNSUPPORTED","يوجد مصروف مسجل بأجزاء من القرش؛ صحح دقته بتسوية موثقة قبل الإقفال",409);
   const unbalanced=expenses.rows.filter(e=>toMinorUnits(e.amount)!==toMinorUnits(e.allocated));
   if(unbalanced.length)throw new AppError("UNALLOCATED_ADMIN_EXPENSES","لا يمكن قفل الفترة قبل توزيع كامل المصروفات الإدارية على الطلبيات",409);
   const start=period.rows[0].period_start,end=period.rows[0].period_end;
   const [cash,custodyMovements,workerDues,adjustments,workerSettlements,payrollPayments,advances,inventory,revenue,expense,pending]=await Promise.all([
    client.query("SELECT e.id AS employee_id,e.code,e.full_name,COALESCE(SUM(CASE WHEN c.direction='IN' THEN c.amount ELSE -c.amount END),0) AS balance FROM employees e LEFT JOIN cash_custody_transactions c ON c.employee_id=e.id AND c.transaction_date<=$1::date GROUP BY e.id,e.code,e.full_name ORDER BY e.code",[end]),
    client.query("SELECT c.id,c.code,c.employee_id,e.code AS employee_code,e.full_name,c.direction,c.amount,c.transaction_date,c.description,c.notes,c.source_type,c.source_id FROM cash_custody_transactions c JOIN employees e ON e.id=c.employee_id WHERE c.transaction_date BETWEEN $1::date AND $2::date ORDER BY c.transaction_date,c.created_at",[start,end]),
    client.query("SELECT e.id AS employee_id,e.code,e.full_name,COALESCE(SUM(l.credit_amount-l.debit_amount),0) AS balance FROM employees e LEFT JOIN employee_earnings_ledger l ON l.employee_id=e.id AND l.created_at::date<=$1::date GROUP BY e.id,e.code,e.full_name ORDER BY e.code",[end]),
    client.query("SELECT l.id,l.code,l.employee_id,e.code AS employee_code,e.full_name,l.entry_type,l.credit_amount,l.debit_amount,l.notes,l.created_at FROM employee_earnings_ledger l JOIN employees e ON e.id=l.employee_id WHERE l.entry_type='ADJUSTMENT' AND l.created_at::date BETWEEN $1::date AND $2::date ORDER BY l.created_at,l.id",[start,end]),
    client.query("SELECT s.id,s.employee_id,e.code AS employee_code,e.full_name,s.gross_amount,s.cash_paid_amount,s.advance_repayment_amount,s.settlement_date,s.notes FROM employee_earnings_settlements s JOIN employees e ON e.id=s.employee_id WHERE s.settlement_date BETWEEN $1::date AND $2::date ORDER BY s.settlement_date,s.created_at",[start,end]),
    client.query("SELECT pp.id,pp.payroll_item_id,pi.employee_id,e.code AS employee_code,e.full_name,pp.amount,pp.payment_date,pp.payment_method,pp.reference,pp.notes FROM payroll_payments pp JOIN payroll_items pi ON pi.id=pp.payroll_item_id JOIN employees e ON e.id=pi.employee_id WHERE pp.payment_date BETWEEN $1::date AND $2::date ORDER BY pp.payment_date,pp.created_at",[start,end]),
    client.query("SELECT a.id,a.code,a.employee_id,e.code AS employee_code,e.full_name,a.amount,GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl JOIN financial_reversals fr ON fr.id=rl.reversal_id AND fr.reversal_date<=$1::date WHERE rl.source_type='ADVANCE_REPAYMENT' AND rl.source_id=ar.id),0)) FROM advance_repayments ar WHERE ar.advance_id=a.id AND ar.payment_date<=$1::date),0),0) AS remaining FROM advance_requests a JOIN employees e ON e.id=a.employee_id WHERE a.status='PAID' AND a.paid_at::date<=$1::date ORDER BY e.code,a.code",[end]),
    client.query("SELECT sm.product_id,sm.warehouse_id,sm.location_id,COALESCE(SUM(CASE WHEN sm.movement_type IN ('IN','RETURN','TRANSFER_IN') OR (sm.movement_type='ADJUSTMENT' AND sm.reference_type IS DISTINCT FROM 'ADJUSTMENT_OUT') THEN sm.quantity ELSE -sm.quantity END),0) AS quantity,COALESCE(SUM(CASE WHEN sm.movement_type IN ('IN','RETURN','TRANSFER_IN') OR (sm.movement_type='ADJUSTMENT' AND sm.reference_type IS DISTINCT FROM 'ADJUSTMENT_OUT') THEN sm.total_cost ELSE -sm.total_cost END),0) AS inventory_value FROM stock_movements sm WHERE sm.created_at::date<=$1::date GROUP BY sm.product_id,sm.warehouse_id,sm.location_id HAVING ABS(COALESCE(SUM(CASE WHEN sm.movement_type IN ('IN','RETURN','TRANSFER_IN') OR (sm.movement_type='ADJUSTMENT' AND sm.reference_type IS DISTINCT FROM 'ADJUSTMENT_OUT') THEN sm.quantity ELSE -sm.quantity END),0))>0.000001 ORDER BY sm.product_id,sm.warehouse_id,sm.location_id",[end]),
    client.query("SELECT COALESCE(SUM(amount),0) AS total FROM order_revenues WHERE revenue_date BETWEEN $1::date AND $2::date AND UPPER(source) IS DISTINCT FROM 'EXTERNAL_CUSTODY_TOP_UP'",[start,end]),
    client.query("SELECT COALESCE(SUM(e.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er JOIN financial_reversals fr ON fr.id=er.reversal_id AND fr.reversal_date<=$2::date WHERE er.expense_id=e.id),0)),0) AS total FROM accounting_expenses e WHERE e.expense_date BETWEEN $1::date AND $2::date",[start,end]),
    client.query("SELECT (SELECT COUNT(*)::int FROM advance_requests WHERE status IN ('PENDING','APPROVED') AND created_at::date<=$1::date) AS pending_advances,(SELECT COUNT(*)::int FROM payroll_items pi JOIN payroll_periods pp ON pp.id=pi.period_id WHERE pi.status IN ('UNPAID','PARTIAL') AND pp.period_month<=$1::date) AS unpaid_payroll_items,(SELECT COUNT(*)::int FROM production_orders WHERE status IN ('DRAFT','PLANNED','IN_PROGRESS')) AS open_production_orders",[end])
   ]);
   const report={period:{id,name:period.rows[0].name,start,end},generatedAt:new Date().toISOString(),totals:{revenue:Number(revenue.rows[0].total),expenses:Number(expense.rows[0].total)},cashCustody:cash.rows,custodyMovements:custodyMovements.rows,workerDues:workerDues.rows,earningsAdjustments:adjustments.rows,workerSettlements:workerSettlements.rows,payrollPayments:payrollPayments.rows,advances:advances.rows,inventory:inventory.rows,pending:pending.rows[0],reviewFlags:{negativeCustodyBalances:cash.rows.filter((row:any)=>Number(row.balance)<0).map((row:any)=>({employeeId:row.employee_id,employeeCode:row.code,employeeName:row.full_name,balance:Number(row.balance),requiresExplanation:true}))}};
   const reportJson=JSON.stringify(report);
   const reportHash=createHash("sha256").update(reportJson).digest("hex");
   const snapshotVersion=await client.query("SELECT COALESCE(MAX(snapshot_no),0)+1 AS next_version FROM accounting_period_close_snapshots WHERE period_id=$1",[id]);
   await client.query("INSERT INTO accounting_period_close_snapshots(period_id,snapshot_no,report,report_json,report_sha256,created_by) VALUES($1,$2,$3::jsonb,$4,$5,$6)",[id,snapshotVersion.rows[0].next_version,reportJson,reportJson,reportHash,request.user!.userId]);

   // A future quarter may already exist when this quarter is closed. Refresh its
   // opening balances from this immutable snapshot, rather than only carrying
   // balances when the future period is first created.
   const nextPeriod=await client.query(
    "SELECT id,status FROM accounting_periods WHERE period_start=($1::date + INTERVAL '1 day')::date ORDER BY period_start LIMIT 1 FOR UPDATE",
    [end]
   );
   // A locked/reviewing next period must not prevent closing this period.
   // Its opening balances are refreshed only while the next period is OPEN.
   if(nextPeriod.rowCount && nextPeriod.rows[0].status==="OPEN"){
    const nextPeriodId=nextPeriod.rows[0].id;
    await client.query("DELETE FROM accounting_period_opening_balances WHERE period_id=$1 AND source_period_id<>$2",[nextPeriodId,id]);
    for(const row of report.cashCustody??[]) await client.query(
     "INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'CASH_CUSTODY',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO UPDATE SET source_period_id=EXCLUDED.source_period_id,balance=EXCLUDED.balance,created_at=now()",
     [nextPeriodId,id,String(row.employee_id),JSON.stringify(row)]
    );
    for(const row of report.workerDues??[]) await client.query(
     "INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'WORKER_DUES',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO UPDATE SET source_period_id=EXCLUDED.source_period_id,balance=EXCLUDED.balance,created_at=now()",
     [nextPeriodId,id,String(row.employee_id),JSON.stringify(row)]
    );
    for(const row of report.advances??[]) if(Number(row.remaining)>0) await client.query(
     "INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'ADVANCE',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO UPDATE SET source_period_id=EXCLUDED.source_period_id,balance=EXCLUDED.balance,created_at=now()",
     [nextPeriodId,id,String(row.id),JSON.stringify(row)]
    );
    for(const row of report.inventory??[]) await client.query(
     "INSERT INTO accounting_period_opening_balances(period_id,source_period_id,balance_type,entity_key,balance) VALUES($1,$2,'INVENTORY',$3,$4::jsonb) ON CONFLICT(period_id,balance_type,entity_key) DO UPDATE SET source_period_id=EXCLUDED.source_period_id,balance=EXCLUDED.balance,created_at=now()",
     [nextPeriodId,id,[row.product_id,row.warehouse_id,row.location_id??''].join(':'),JSON.stringify(row)]
    );
    await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"carry_forward",module:"finance",entityType:"accounting_period",entityId:nextPeriodId,afterData:{sourcePeriodId:id,openingBalanceTypes:["CASH_CUSTODY","WORKER_DUES","ADVANCE","INVENTORY"],trigger:"source_period_close"},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   }
   const r=await client.query("UPDATE accounting_periods SET status='CLOSED',closed_by=$2,closed_at=now(),approved_by=$2,approved_at=now() WHERE id=$1 RETURNING *",[id,request.user!.userId]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"close",module:"finance",entityType:"accounting_period",entityId:id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  })};
 });



 app.get("/api/accounting/periods/:id/report",{preHandler:[authenticateRequest,requirePermission("finance.period_close.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const r=await pool.query("SELECT p.id AS period_id,p.name,p.period_start,p.period_end,p.status,s.snapshot_no,s.report,s.report_json,s.report_sha256,s.created_by,s.created_at FROM accounting_periods p JOIN LATERAL (SELECT * FROM accounting_period_close_snapshots WHERE period_id=p.id ORDER BY snapshot_no DESC LIMIT 1) s ON TRUE WHERE p.id=$1",[id]);
  if(!r.rowCount)throw new AppError("ACCOUNTING_PERIOD_REPORT_NOT_FOUND","لا يوجد تقرير إقفال محفوظ لهذه الفترة",404);
  const report=r.rows[0];
  const reportJson=String(report.report_json);
  const integrityVerified=createHash("sha256").update(reportJson).digest("hex")===report.report_sha256;
  let immutableReport:unknown=null;
  try{immutableReport=JSON.parse(reportJson);}catch{/* Preserve a failed integrity signal and never display the mutable JSONB copy as verified evidence. */}
  return {data:{...report,report:immutableReport,integrityVerified}};
 });

 app.post("/api/accounting/periods/:id/reopen",{preHandler:[authenticateRequest,requirePermission("finance.period_close.reopen")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const p=z.object({reason:z.string().trim().min(10).max(1000)}).safeParse(request.body);
  if(!p.success)throw new AppError("REOPEN_REASON_REQUIRED","يجب كتابة سبب واضح لإعادة فتح الفترة (10 أحرف على الأقل)",422);
  return {data:await withTransaction(async client=>{
   const period=await client.query("SELECT * FROM accounting_periods WHERE id=$1 FOR UPDATE",[id]);
   if(!period.rowCount)throw new AppError("ACCOUNTING_PERIOD_NOT_FOUND","الفترة المالية غير موجودة",404);
   if(period.rows[0].status!=="CLOSED")throw new AppError("ACCOUNTING_PERIOD_NOT_CLOSED","يمكن إعادة فتح فترة مقفولة فقط",409);
   // Do not reopen an earlier period while a later period is under review or
   // closed. Corrections would otherwise change the source snapshot while the
   // later period's opening balances are frozen and cannot be refreshed.
   const laterLocked=await client.query(
    "SELECT id,name,status FROM accounting_periods WHERE period_start>$1::date AND status<>'OPEN' ORDER BY period_start LIMIT 1 FOR UPDATE",
    [period.rows[0].period_start]
   );
   if(laterLocked.rowCount)throw new AppError("NEXT_ACCOUNTING_PERIOD_LOCKED","لا يمكن إعادة فتح فترة أسبق بينما توجد فترة لاحقة قيد المراجعة أو مقفولة؛ عالج الفترات بترتيب زمني عكسي أولًا",409);
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
    COALESCE((SELECT SUM(e.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)) FROM accounting_expenses e WHERE e.order_id=o.id AND e.expense_type='DIRECT' AND e.category IS DISTINCT FROM 'WORKER_PAYMENT' AND ($1::date IS NULL OR e.expense_date BETWEEN $1::date AND $2::date)),0)
    +COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
      WHERE ev.target_order_id=o.id AND ev.event_type='TRANSFERRED_TO_SOURCE_ORDER'
        AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)
        AND ($1::date IS NULL OR ev.created_at::date BETWEEN $1::date AND $2::date)),0) AS direct_expenses,
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
     COALESCE((SELECT SUM(e.amount-COALESCE((SELECT SUM(er.amount) FROM accounting_expense_reversals er WHERE er.expense_id=e.id),0)) FROM accounting_expenses e WHERE e.order_id=$1 AND e.expense_type='DIRECT' AND e.category IS DISTINCT FROM 'WORKER_PAYMENT'),0)
    +COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
      WHERE ev.target_order_id=$1 AND ev.event_type='TRANSFERRED_TO_SOURCE_ORDER'
        AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id)),0) AS value,
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
