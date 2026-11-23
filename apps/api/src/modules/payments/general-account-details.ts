import type { PoolClient } from "pg";
import { amountUnits, roundedAmount } from "./settlement-money.js";
import { activeDifferencePaymentProductionAllocationSql, productionPaidSql, paymentAllocatedSql } from "./settlement-calculation.js";

type DetailRow={source_type:string;source_id:string;source_code:string|null;occurred_at:string|Date|null;order_id:string|null;description:string|null;amount:string;scope:string;needs_review:boolean};

/** Explain a read-only projection. Source descriptions are data, never classifiers. */
export async function getGeneralAccountDetails(client:PoolClient,employeeId:string,total:number,orderTotal:number){
  const state=await client.query(`SELECT
    (SELECT closed_at FROM employee_production_closures WHERE employee_id=$1 AND status='ACTIVE' ORDER BY closed_at DESC LIMIT 1) AS cutoff,
    (SELECT COUNT(*)::int FROM production_entries WHERE employee_id=$1 AND status='APPROVED') AS approved_count`,[employeeId]);
  const cutoff=state.rows[0]?.cutoff??null;
  const fallback=!cutoff&&Number(state.rows[0]?.approved_count??0)===0;
  const globalRows=fallback?await client.query<DetailRow>(`
    SELECT 'LEDGER_FALLBACK' AS source_type,l.id::text AS source_id,l.code AS source_code,l.created_at AS occurred_at,
      NULL::text AS order_id,l.notes AS description,(l.credit_amount-l.debit_amount)::text AS amount,
      'GLOBAL_LEDGER_FALLBACK' AS scope,TRUE AS needs_review
    FROM employee_earnings_ledger l WHERE l.employee_id=$1
      AND l.payroll_item_id IS NULL AND l.payroll_adjustment_line_id IS NULL AND l.payroll_payment_id IS NULL
    UNION ALL
    SELECT 'OUTSTANDING_ADVANCE_ADD_BACK',a.id::text,a.code,a.paid_at,NULL,a.reason,
      GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl
        WHERE rl.source_type='ADVANCE_REPAYMENT' AND rl.source_id=ar.id),0)) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0)::text,
      'GLOBAL_LEDGER_FALLBACK',FALSE
    FROM advance_requests a WHERE a.employee_id=$1 AND a.status='PAID' AND a.repayment_status='OPEN'
  `,[employeeId]):await client.query<DetailRow>(`
    SELECT 'PRODUCTION' AS source_type,p.id::text AS source_id,p.code AS source_code,p.approved_at AS occurred_at,
      os.order_id::text AS order_id,NULL::text AS description,COALESCE(p.total_earning_amount,p.earning_amount,0)::text AS amount,
      'GLOBAL_PROJECTION' AS scope,FALSE AS needs_review
    FROM production_entries p LEFT JOIN order_stages os ON os.id=p.order_stage_id
    WHERE p.employee_id=$1 AND p.status='APPROVED' AND ($2::timestamptz IS NULL OR p.approved_at>$2)
    UNION ALL
    SELECT 'STANDALONE_ADJUSTMENT',a.id::text,NULL,a.created_at,NULL,a.reason,
      (CASE WHEN a.adjustment_type='BONUS' THEN a.amount ELSE -a.amount END)::text,'GLOBAL_PROJECTION',FALSE
    FROM employee_earnings_adjustments a WHERE a.employee_id=$1 AND a.production_entry_id IS NULL
      AND ($2::timestamptz IS NULL OR a.created_at>$2)
    UNION ALL
    SELECT CASE WHEN EXISTS(SELECT 1 FROM advance_requests a WHERE a.ledger_entry_id=l.id)
      THEN 'ADVANCE_PRINCIPAL_LEDGER' ELSE 'UNLINKED_LEDGER_ADJUSTMENT' END,l.id::text,l.code,l.created_at,NULL,l.notes,
      (l.credit_amount-l.debit_amount)::text,'GLOBAL_PROJECTION',
      NOT EXISTS(SELECT 1 FROM advance_requests a WHERE a.ledger_entry_id=l.id)
    FROM employee_earnings_ledger l WHERE l.employee_id=$1 AND l.entry_type='ADJUSTMENT' AND l.production_entry_id IS NULL
      AND l.advance_repayment_id IS NULL AND l.payroll_item_id IS NULL AND l.payroll_adjustment_line_id IS NULL
      AND l.payroll_payment_id IS NULL AND l.settlement_id IS NULL AND l.financial_reversal_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM employee_earnings_adjustments a WHERE a.ledger_id=l.id)
      AND ($2::timestamptz IS NULL OR l.created_at>$2)
    UNION ALL
    SELECT 'CANCELLED_APPROVAL_BRIDGE',l.id::text,l.code,p.cancelled_at,NULL,l.notes,
      (l.credit_amount-l.debit_amount)::text,'GLOBAL_PROJECTION',FALSE
    FROM employee_earnings_ledger l JOIN production_entries p ON p.id=l.production_entry_id
    WHERE p.employee_id=$1 AND p.status='CANCELLED' AND l.entry_type='PRODUCTION_APPROVAL'
      AND ($2::timestamptz IS NULL OR p.cancelled_at>$2)
    UNION ALL
    SELECT 'CANCELLED_ADJUSTMENT_BRIDGE',a.id::text,NULL,p.cancelled_at,NULL,a.reason,
      (CASE WHEN a.adjustment_type='BONUS' THEN a.amount ELSE -a.amount END)::text,'GLOBAL_PROJECTION',FALSE
    FROM employee_earnings_adjustments a JOIN production_entries p ON p.id=a.production_entry_id
    WHERE a.employee_id=$1 AND p.status='CANCELLED' AND a.ledger_id IS NOT NULL
      AND ($2::timestamptz IS NULL OR p.cancelled_at>$2)
    UNION ALL
    SELECT 'PRICE_DELTA_EXCLUSION',pci.id::text,pc.code,pci.created_at,pc.order_id::text,pc.reason,
      (-pci.delta_amount)::text,'GLOBAL_PROJECTION',FALSE
    FROM order_price_change_items pci JOIN order_price_changes pc ON pc.id=pci.price_change_id
    WHERE pci.employee_id=$1 AND pci.ledger_adjustment=TRUE AND ($2::timestamptz IS NULL OR pci.created_at>$2)
    UNION ALL
    SELECT 'ADVANCE_PRINCIPAL_EXCLUSION',l.id::text,a.code,l.created_at,NULL,a.reason,
      (l.debit_amount-l.credit_amount)::text,'GLOBAL_PROJECTION',FALSE
    FROM advance_requests a JOIN employee_earnings_ledger l ON l.id=a.ledger_entry_id
    WHERE a.employee_id=$1 AND ($2::timestamptz IS NULL OR l.created_at>$2)
    UNION ALL
    SELECT 'SETTLEMENT',s.id::text,NULL,s.created_at,NULL,s.notes,
      (-(CASE WHEN s.worker_payment_id IS NOT NULL AND EXISTS(SELECT 1 FROM worker_payment_settlement_differences d WHERE d.worker_payment_id=s.worker_payment_id)
        THEN ${activeDifferencePaymentProductionAllocationSql("s.worker_payment_id","s.id","AND ($2::timestamptz IS NULL OR p.approved_at>$2)")}
        ELSE s.gross_amount-CASE WHEN s.worker_payment_id IS NOT NULL THEN COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='WORKER_PAYMENT' AND rl.source_id=s.worker_payment_id),0) ELSE 0 END END))::text,
      'GLOBAL_PROJECTION',FALSE
    FROM employee_earnings_settlements s WHERE s.employee_id=$1 AND ($2::timestamptz IS NULL OR s.created_at>$2)
    UNION ALL
    SELECT 'LEGACY_PAYMENT',wp.id::text,NULL,wp.created_at,NULL,wp.notes,
      (-(CASE WHEN EXISTS(SELECT 1 FROM worker_payment_settlement_differences d WHERE d.worker_payment_id=wp.id)
        THEN ${activeDifferencePaymentProductionAllocationSql("wp.id",null,"AND ($2::timestamptz IS NULL OR p.approved_at>$2)")}
        ELSE wp.gross_amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='WORKER_PAYMENT' AND rl.source_id=wp.id),0) END))::text,
      'GLOBAL_PROJECTION',FALSE
    FROM worker_payments wp WHERE wp.employee_id=$1 AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements s WHERE s.worker_payment_id=wp.id)
      AND ($2::timestamptz IS NULL OR wp.created_at>$2)
    UNION ALL
    SELECT 'HISTORICAL_MARK',m.id::text,p.code,p.approved_at,NULL,NULL,(-m.amount_snapshot)::text,'GLOBAL_PROJECTION',FALSE
    FROM historical_production_settlement_marks m JOIN production_entries p ON p.id=m.production_entry_id
    WHERE m.employee_id=$1 AND m.status='PAID_PREVIOUSLY' AND p.status='APPROVED'
      AND ($2::timestamptz IS NULL OR p.approved_at>$2)
  `,[employeeId,cutoff]);
  // Reverse the unrounded per-order projection, exposing each production/payment
  // contribution instead of disguising a discrepancy as carry or rounding.
  const orderRows=await client.query<DetailRow>(`
    SELECT 'ORDER_PRODUCTION_BRIDGE' AS source_type,p.id::text AS source_id,p.code AS source_code,p.approved_at AS occurred_at,
      os.order_id::text AS order_id,NULL::text AS description,
      (-COALESCE(p.total_earning_amount,p.earning_amount,0)+(${productionPaidSql("p.id")}))::text AS amount,
      CASE WHEN $2::timestamptz IS NOT NULL AND p.approved_at<=$2 THEN 'CLOSURE_EXCLUSION' ELSE 'ORDER_RECONCILIATION' END AS scope,
      FALSE AS needs_review
    FROM production_entries p JOIN order_stages os ON os.id=p.order_stage_id
    WHERE p.employee_id=$1 AND p.status='APPROVED'
    UNION ALL
    SELECT 'ORDER_PAYMENT_RESIDUAL_BRIDGE',wp.id::text,NULL,wp.created_at,ae.order_id::text,wp.notes,
      GREATEST(wp.gross_amount-COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='WORKER_PAYMENT' AND rl.source_id=wp.id),0)
        -(${paymentAllocatedSql("wp.id")}),0)::text,'ORDER_RECONCILIATION',FALSE
    FROM worker_payments wp JOIN (SELECT DISTINCT idempotency_key,order_id FROM accounting_expenses WHERE source_worker_payment_id IS NULL) ae
      ON ae.idempotency_key=wp.idempotency_key
    WHERE wp.employee_id=$1 AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_differences d WHERE d.worker_payment_id=wp.id)
      AND EXISTS(SELECT 1 FROM production_entries p JOIN order_stages os ON os.id=p.order_stage_id
        WHERE p.employee_id=$1 AND p.status='APPROVED' AND os.order_id=ae.order_id)
  `,[employeeId,cutoff]);
  const rows=[...globalRows.rows,...orderRows.rows];
  const rawSum=rows.reduce((sum,row)=>sum+amountUnits(row.amount),0n);
  const target=amountUnits(Math.round((total-orderTotal)*100)/100);
  const discrepancy=target-rawSum;
  const globalRaw=globalRows.rows.reduce((sum,row)=>sum+amountUnits(row.amount),0n);
  // Prove the global-source projection independently before calling a difference rounding.
  const byOrder=new Map<string,bigint>();
  for(const row of orderRows.rows){if(row.order_id)byOrder.set(row.order_id,(byOrder.get(row.order_id)??0n)-amountUnits(row.amount));}
  const reconstructedOrders=[...byOrder.values()].reduce((sum,value)=>sum+amountUnits(roundedAmount(value)),0n);
  const roundingOnly=amountUnits(roundedAmount(globalRaw))===amountUnits(total)
    && reconstructedOrders===amountUnits(orderTotal);
  const entries=rows.filter(row=>amountUnits(row.amount)!==0n).map((row,index)=>({
    key:row.source_type+":"+row.source_id+":"+index,sourceType:row.source_type,sourceId:row.source_id,sourceCode:row.source_code,
    occurredAt:row.occurred_at,orderId:row.order_id,description:row.description,
    amount:Number(row.amount),amountExact:row.amount,scope:row.scope,needsReview:row.needs_review,
    provenance:row.needs_review?"UNRESOLVED_HISTORICAL_SOURCE":"STRUCTURED_SOURCE"
  }));
  return {mode:fallback?"LEDGER_FALLBACK":cutoff?"CLOSURE_PROJECTION":"PRODUCTION_PROJECTION",closureCutoff:cutoff,
    entries,sourceEffectsTotal:roundedAmount(rawSum),roundingAdjustment:roundingOnly?Number(discrepancy)/10000:0,
    unexplainedDifference:roundingOnly?0:Number(discrepancy)/10000,total:Number(target)/10000,
    needsReview:entries.some(row=>row.needsReview)||!roundingOnly,
    explanation:"GLOBAL_SOURCE_EFFECTS_MINUS_SIGNED_ORDER_PROJECTION"};
}
