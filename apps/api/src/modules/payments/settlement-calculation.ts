/** Internal SQL fragments only. Callers pass trusted SQL expressions, never request text. */
export function netAllocationSql(alias:string, source:string):string {
  return `${alias}.amount-COALESCE((SELECT SUM(r.amount) FROM worker_payment_allocation_reversals r WHERE r.allocation_source='${source}' AND r.source_allocation_id=${alias}.id),0)`;
}

export function canonicalAllocationExistsSql(payment:string):string {
  return `EXISTS(SELECT 1 FROM employee_earnings_settlements es JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id WHERE es.worker_payment_id=${payment})`;
}

export function orderAllocationExistsSql(payment:string):string {
  return `EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=${payment})`;
}

/** Allocation existence, not settlement-link existence, selects the lineage. */
export function paymentAllocatedSql(payment:string):string {
  return `CASE
    WHEN ${canonicalAllocationExistsSql(payment)} THEN COALESCE((
      SELECT SUM(${netAllocationSql("a","EMPLOYEE_EARNINGS_SETTLEMENT")})
      FROM employee_earnings_settlement_allocations a
      JOIN employee_earnings_settlements es ON es.id=a.settlement_id
      WHERE es.worker_payment_id=${payment}),0)
    WHEN ${orderAllocationExistsSql(payment)} THEN COALESCE((
      SELECT SUM(${netAllocationSql("a","WORKER_PAYMENT_ORDER")})
      FROM worker_payment_order_allocations a WHERE a.worker_payment_id=${payment}),0)
    ELSE COALESCE((SELECT SUM(${netAllocationSql("a","WORKER_PAYMENT_LEGACY")})
      FROM worker_payment_allocations a WHERE a.worker_payment_id=${payment}),0)
  END`;
}

export function productionPaidSql(production:string):string {
  return `COALESCE((SELECT SUM(${netAllocationSql("a","EMPLOYEE_EARNINGS_SETTLEMENT")}) FROM employee_earnings_settlement_allocations a WHERE a.production_entry_id=${production}),0)
    +COALESCE((SELECT SUM(${netAllocationSql("a","WORKER_PAYMENT_ORDER")}) FROM worker_payment_order_allocations a WHERE a.production_entry_id=${production} AND NOT ${canonicalAllocationExistsSql("a.worker_payment_id")}),0)
    +COALESCE((SELECT SUM(${netAllocationSql("a","WORKER_PAYMENT_LEGACY")}) FROM worker_payment_allocations a WHERE a.production_entry_id=${production} AND NOT ${canonicalAllocationExistsSql("a.worker_payment_id")} AND NOT ${orderAllocationExistsSql("a.worker_payment_id")}),0)
    +COALESCE((SELECT SUM(ev.amount) FROM worker_payment_settlement_difference_events ev
      WHERE ev.production_entry_id=${production} AND ev.event_type='ALLOCATED_TO_PRODUCTION'
        AND ${canonicalAllocationExistsSql("ev.worker_payment_id")}
        AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv WHERE rv.reverses_event_id=ev.id AND rv.event_type='REVERSED')),0)
    +COALESCE((SELECT SUM(hm.amount_snapshot) FROM historical_production_settlement_marks hm WHERE hm.production_entry_id=${production} AND hm.status='PAID_PREVIOUSLY'),0)`;
}

/** Signed order account, shared by summary, payout validation and order tables. */
export function orderAccountSql():string {
  return `WITH production_due AS (
    SELECT p.id,p.employee_id,os.order_id,p.order_stage_id,
      COALESCE(p.total_earning_amount,p.earning_amount,0) AS earned,
      ${productionPaidSql("p.id")} AS paid
    FROM production_entries p JOIN order_stages os ON os.id=p.order_stage_id
    WHERE p.employee_id=$1 AND p.status='APPROVED' AND os.order_id=$2
      AND ($3::uuid IS NULL OR p.order_stage_id=$3)
  ), legacy_remainder AS (
    SELECT COALESCE(SUM(GREATEST(wp.gross_amount
      -COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='WORKER_PAYMENT' AND rl.source_id=wp.id),0)
      -(${paymentAllocatedSql("wp.id")}),0)),0) AS amount
    FROM worker_payments wp
    WHERE wp.employee_id=$1
      AND EXISTS(SELECT 1 FROM accounting_expenses ae
        WHERE ae.idempotency_key=wp.idempotency_key AND ae.source_worker_payment_id IS NULL
          AND ae.order_id=$2 AND ($3::uuid IS NULL OR ae.order_stage_id=$3))
      AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_differences d WHERE d.worker_payment_id=wp.id)
  )
  SELECT COALESCE(SUM(earned),0) AS earned,
    COALESCE(SUM(paid),0) AS allocated_paid,
    COUNT(*)::int AS production_count,
    (SELECT amount FROM legacy_remainder) AS legacy_order_paid,
    ROUND(COALESCE(SUM(earned-paid),0)-(SELECT amount FROM legacy_remainder),2) AS remaining
  FROM production_due`;
}

/** Bridge source entitlements to anonymous historical ledger adjustments without notes matching.
 * Cancelled-source original credits offset their reversal debits. Price deltas already
 * included in current approved entitlement and advance-principal payouts are not wages.
 * Edits of approved records post a mirror ledger entry for their net delta (production_entry_corrections.earning_delta),
 * but the edited record value already carries that delta, so the mirror entry must not be added again.
 */
export function projectionAdjustmentBridgeSql(employee:string,cutoff?:string):string {
  const after=(column:string)=>cutoff?` AND ${column}>${cutoff}`:"";
  return `COALESCE((SELECT SUM(l.credit_amount-l.debit_amount)
    FROM employee_earnings_ledger l JOIN production_entries p ON p.id=l.production_entry_id
    WHERE p.employee_id=${employee} AND p.status='CANCELLED' AND l.entry_type='PRODUCTION_APPROVAL'
      ${after("p.cancelled_at")}),0)
    +COALESCE((SELECT SUM(CASE WHEN a.adjustment_type='BONUS' THEN a.amount ELSE -a.amount END)
      FROM employee_earnings_adjustments a JOIN production_entries p ON p.id=a.production_entry_id
      WHERE a.employee_id=${employee} AND p.status='CANCELLED' AND a.ledger_id IS NOT NULL
        ${after("p.cancelled_at")}),0)
    -COALESCE((SELECT SUM(pci.delta_amount) FROM order_price_change_items pci
      JOIN production_entries p ON p.id=pci.production_entry_id
      WHERE pci.employee_id=${employee} AND pci.ledger_adjustment=TRUE
        ${after("pci.created_at")}),0)
    -COALESCE((SELECT SUM(c.earning_delta) FROM production_entry_corrections c
      JOIN production_entries p ON p.id=c.production_entry_id
      WHERE p.employee_id=${employee} AND p.status='APPROVED'
        ${after("c.created_at")}),0)
    +COALESCE((SELECT SUM(l.debit_amount-l.credit_amount) FROM advance_requests a
      JOIN employee_earnings_ledger l ON l.id=a.ledger_entry_id
      WHERE a.employee_id=${employee} ${after("l.created_at")}),0)`;
}


export async function getSettlementReconciliation(client:import("pg").PoolClient,employeeId:string,available:number) {
  const result=await client.query(`WITH production_due AS (
    SELECT p.id,os.order_id,o.code AS order_code,o.order_name,
      COALESCE(p.total_earning_amount,p.earning_amount,0) AS earned,
      ${productionPaidSql("p.id")} AS paid
    FROM production_entries p LEFT JOIN order_stages os ON os.id=p.order_stage_id
    LEFT JOIN production_orders o ON o.id=os.order_id
    WHERE p.employee_id=$1 AND p.status='APPROVED'
  ), residual AS (
    SELECT ae.order_id,SUM(GREATEST(wp.gross_amount
      -COALESCE((SELECT SUM(rl.amount) FROM financial_reversal_lines rl WHERE rl.source_type='WORKER_PAYMENT' AND rl.source_id=wp.id),0)
      -(${paymentAllocatedSql("wp.id")}),0)) AS amount
    FROM worker_payments wp
    JOIN (SELECT DISTINCT idempotency_key,order_id FROM accounting_expenses WHERE source_worker_payment_id IS NULL) ae
      ON ae.idempotency_key=wp.idempotency_key
    WHERE wp.employee_id=$1 AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_differences d WHERE d.worker_payment_id=wp.id)
    GROUP BY ae.order_id
  ) SELECT pd.order_id,pd.order_code,pd.order_name,
      SUM(pd.earned) AS earned,SUM(pd.paid)+COALESCE(MAX(r.amount),0) AS paid,
      ROUND(SUM(pd.earned-pd.paid)-COALESCE(MAX(r.amount),0),2) AS remaining
    FROM production_due pd LEFT JOIN residual r ON r.order_id=pd.order_id
    WHERE pd.order_id IS NOT NULL GROUP BY pd.order_id,pd.order_code,pd.order_name
    ORDER BY pd.order_code`,[employeeId]);
  const orders=result.rows.map(row=>({orderId:row.order_id,orderCode:row.order_code,orderName:row.order_name,
    earned:Number(row.earned),paid:Number(row.paid),remaining:Number(row.remaining)}));
  // No implicit transfer into orders. Includes standalone adjustments, carry,
  // no-order production, closure exclusions and account-boundary rounding.
  const orderTotal=Math.round(orders.reduce((sum,row)=>sum+row.remaining,0)*100)/100;
  return {orders,orderTotal,generalAccount:Math.round((available-orderTotal)*100)/100,total:available,
    allocationPolicy:"SIGNED_ORDER_BALANCES_PLUS_GENERAL_ACCOUNT"};
}
