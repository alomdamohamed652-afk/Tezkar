import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { assertAccountingPeriodOpen } from "./period-lock.service.js";

export const reversalSchema=z.object({
  sourceType:z.enum(["PAYROLL_PAYMENT","ADVANCE_REPAYMENT","ZERO_NET_PAYROLL_SETTLEMENT","WORKER_PAYMENT","WORKER_SETTLEMENT_DIFFERENCE_EVENT"]),
  sourceId:z.string().uuid(),
  amount:z.number().positive().max(100000000).refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,{message:"المبلغ يجب أن يكون بحد أقصى منزلتين عشريتين"}),
  reason:z.string().trim().min(2).max(500),
  idempotencyKey:z.string().uuid()
});
export type FinancialReversalInput=z.infer<typeof reversalSchema>;
export type FinancialReversalActor={userId:string;employeeId:string|null;ip:string|null;userAgent:string|null};

/** Shared by POST /api/accounting/reversals and the production-cancellation flow. Runs inside the caller's transaction. Behavior is unchanged from the original inline handler. */
export async function executeFinancialReversal(client:PoolClient,input:FinancialReversalInput,actor:FinancialReversalActor){
  const requestFingerprint=createHash("sha256").update(JSON.stringify({sourceType:input.sourceType,sourceId:input.sourceId,amountMinor:Math.round(input.amount*100),reason:input.reason})).digest("hex");
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
    const previousCustodySettlement=payment.settlement_source==="PREVIOUS_CUSTODY";
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
   const header=await client.query("INSERT INTO financial_reversals(idempotency_key,request_fingerprint,reason,reversal_date,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",[input.idempotencyKey,requestFingerprint,input.reason,reversalDate,actor.userId]);
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
      event.id,header.rows[0].id,actor.userId,"عكس مستقل لحدث فرق التسوية: "+input.reason]);
    await client.query(
     "UPDATE worker_payment_settlement_differences SET status='REQUIRES_REVIEW',updated_at=now() WHERE id=$1",
     [settlementDifferenceEventReversal.differenceId]);
   }
   for(const expense of expenseReversals)await client.query(
    `INSERT INTO accounting_expense_reversals(reversal_id,expense_id,source_worker_payment_id,amount,created_by)
     VALUES($1,$2,$3,$4,$5)`,
    [header.rows[0].id,expense.expenseId,expense.workerPaymentId,expense.amount,actor.userId]);
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
        event.id,header.rows[0].id,actor.userId,"عكس فرق التسوية ضمن عكس دفعة العامل"]);
      settlementDifferenceReversals.push({differenceId:event.difference_id,eventId:event.id,amount:Number(event.amount)});
     }
     await client.query("UPDATE worker_payment_settlement_differences SET status='REVERSED',updated_at=now() WHERE id=$1",[difference.rows[0].id]);
    }
   }
   for(const allocation of allocationReversals)await client.query(
    `INSERT INTO worker_payment_allocation_reversals(reversal_id,worker_payment_id,allocation_source,source_allocation_id,production_entry_id,amount,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [header.rows[0].id,allocation.workerPaymentId,allocation.source,allocation.sourceAllocationId,allocation.productionEntryId,allocation.amount,actor.userId]);
   for(const move of ledgerMoves)await client.query(`INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,debit_amount,created_by,notes,financial_reversal_id)
     VALUES($1,'ADJUSTMENT',$2,$3,$4,$5,$6)`,[move.employeeId,move.credit,move.debit,actor.userId,move.notes+" · "+header.rows[0].code,header.rows[0].id]);
   for(const move of custodyMoves)await client.query(`INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by)
     VALUES($1,$2,$3,$4,$5,$6,'FINANCIAL_REVERSAL',$7,$8)`,[move.employeeId,move.direction,move.amount,reversalDate,move.description,"سبب العكس: "+input.reason,header.rows[0].id,actor.userId]);
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
   await writeAudit(client,{actorUserId:actor.userId,actorEmployeeId:actor.employeeId,action:"reverse",module:"finance",entityType:"financial_reversal",entityId:header.rows[0].id,afterData:header.rows[0],metadata:{lines,allocationReversals,expenseReversals,settlementDifferenceReversals,settlementDifferenceEventReversal:settlementDifferenceEventReversal?{eventId:settlementDifferenceEventReversal.event.id,differenceId:settlementDifferenceEventReversal.differenceId}:null,reason:input.reason},ipAddress:actor.ip,userAgent:actor.userAgent});
   return {replayed:false,reversal:header.rows[0],lines};
}
