import { pool } from "../../db/pool.js";

type ReconciliationIssue = {
  workerPaymentId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  issueType: string;
  expected: number | string | null;
  actual: number | string | null;
  details: Record<string, unknown>;
};

const amount = (value: unknown) => Number(value ?? 0);
const near = (left: unknown, right: unknown, tolerance = 0.01) =>
  Math.abs(amount(left) - amount(right)) <= tolerance;

/**
 * Read-only, payment-centred reconciliation.
 * It compares each worker payment with its settlement, earnings ledger,
 * advance repayments, expense, cash custody, production allocations,
 * difference-event ledger and (when present) its full reversal.
 * It deliberately reports findings; it never repairs or posts anything.
 */
export async function reconcileWorkerPayments() {
  const result = await pool.query(`
    SELECT
      wp.id AS worker_payment_id,
      wp.employee_id,
      emp.code AS employee_code,
      emp.full_name AS employee_name,
      wp.gross_amount,
      wp.amount AS cash_paid_amount,
      wp.advance_repayment_amount,
      wp.idempotency_key,
      COALESCE(settlements.row_count,0) AS settlement_count,
      COALESCE(settlements.mismatch_count,0) AS settlement_mismatch_count,
      COALESCE(settlements.previous_custody,FALSE) AS previous_custody,
      COALESCE(ledger.row_count,0) AS ledger_count,
      COALESCE(ledger.debit_total,0) AS ledger_debit,
      COALESCE(ledger.credit_total,0) AS ledger_credit,
      COALESCE(ledger.wrong_employee_count,0) AS ledger_wrong_employee_count,
      COALESCE(ledger.settlement_link_mismatch_count,0) AS ledger_settlement_link_mismatch_count,
      COALESCE(repayments.row_count,0) AS repayment_count,
      COALESCE(repayments.amount_total,0) AS repayment_total,
      COALESCE(repayments.mismatch_count,0) AS repayment_mismatch_count,
      COALESCE(repayments.status_mismatch_count,0) AS advance_status_mismatch_count,
      COALESCE(repayment_reversal.row_count,0) AS repayment_reversal_count,
      COALESCE(repayment_reversal.amount_total,0) AS repayment_reversal_amount,
      COALESCE(expenses.row_count,0) AS expense_count,
      COALESCE(expenses.amount_total,0) AS expense_total,
      COALESCE(expenses.holder_count,0) AS expense_holder_count,
      COALESCE(expenses.holder_row_count,0) AS expense_holder_row_count,
      COALESCE(expenses.custody_link_count,0) AS expense_custody_link_count,
      COALESCE(expenses.custody_link_mismatch_count,0) AS expense_custody_link_mismatch_count,
      expenses.holder_id AS expense_holder_id,
      COALESCE(custody.out_count,0) AS custody_out_count,
      COALESCE(custody.out_amount,0) AS custody_out_amount,
      COALESCE(custody.holder_count,0) AS custody_out_holder_count,
      custody.holder_id AS custody_out_holder_id,
      COALESCE(allocations.source_count,0) AS allocation_count,
      COALESCE(allocations.mismatch_count,0) AS allocation_mismatch_count,
      COALESCE(allocations.active_amount,0) AS allocation_amount,
      COALESCE(allocations.source_amount,0) AS allocation_source_amount,
      COALESCE(allocations.reversal_count,0) AS allocation_reversal_count,
      COALESCE(allocations.reversal_amount,0) AS allocation_reversal_amount,
      COALESCE(difference.original_amount,0) AS difference_original_amount,
      COALESCE(difference.active_amount,0) AS difference_active_amount,
      COALESCE(difference.source_event_count,0) AS difference_source_event_count,
      COALESCE(difference.reversed_event_count,0) AS difference_reversed_event_count,
      COALESCE(parent_reversal.row_count,0) AS parent_reversal_count,
      COALESCE(parent_reversal.amount_total,0) AS parent_reversal_amount,
      COALESCE(expense_reversal.amount_total,0) AS expense_reversal_amount,
      COALESCE(expense_reversal.row_count,0) AS expense_reversal_count,
      COALESCE(custody_reversal.row_count,0) AS custody_reversal_count,
      COALESCE(custody_reversal.amount_total,0) AS custody_reversal_in,
      COALESCE(custody_reversal.holder_count,0) AS custody_reversal_holder_count,
      custody_reversal.holder_id AS custody_reversal_holder_id,
      COALESCE(reversal_ledger.row_count,0) AS reversal_ledger_count,
      COALESCE(reversal_ledger.credit_total,0) AS reversal_ledger_credit,
      COALESCE(reversal_ledger.debit_total,0) AS reversal_ledger_debit,
      COALESCE(reversal_ledger.wrong_employee_count,0) AS reversal_ledger_wrong_employee_count,
      COALESCE(difference.active_event_count,0) AS difference_active_event_count
    FROM worker_payments wp
    JOIN employees emp ON emp.id=wp.employee_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,
             COUNT(*) FILTER(WHERE es.employee_id IS DISTINCT FROM wp.employee_id
               OR ABS(es.gross_amount-wp.gross_amount)>0.01
               OR ABS(es.cash_paid_amount-wp.amount)>0.01
               OR ABS(es.advance_repayment_amount-wp.advance_repayment_amount)>0.01)::int AS mismatch_count,
             BOOL_OR(COALESCE(es.notes,'') LIKE '%تسوية من عهدة سابقة%') AS previous_custody
        FROM employee_earnings_settlements es
       WHERE es.worker_payment_id=wp.id
    ) settlements ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,
             COALESCE(SUM(l.debit_amount),0) AS debit_total,
             COALESCE(SUM(l.credit_amount),0) AS credit_total,
             COUNT(*) FILTER(WHERE l.employee_id IS DISTINCT FROM wp.employee_id)::int AS wrong_employee_count,
             COUNT(*) FILTER(WHERE l.settlement_id IS DISTINCT FROM (
               SELECT es.id FROM employee_earnings_settlements es
                WHERE es.worker_payment_id=wp.id ORDER BY es.created_at,es.id LIMIT 1
             ))::int AS settlement_link_mismatch_count
        FROM employee_earnings_ledger l WHERE l.worker_payment_id=wp.id
    ) ledger ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,
             COALESCE(SUM(ar.amount),0) AS amount_total,
             COUNT(*) FILTER(WHERE a.employee_id IS DISTINCT FROM wp.employee_id
               OR el.ledger_count<>1
               OR el.employee_id IS DISTINCT FROM wp.employee_id
               OR (ar.settlement_id IS NOT NULL AND es.worker_payment_id IS DISTINCT FROM wp.id)
               OR ABS(el.credit_amount-ar.amount)>0.01
               OR ABS(el.debit_amount)>0.01)::int AS mismatch_count,
             COUNT(DISTINCT a.id) FILTER(WHERE
               CASE
                 WHEN GREATEST(a.amount-COALESCE((
                   SELECT SUM(ar2.amount-COALESCE((SELECT SUM(rl.amount)
                     FROM financial_reversal_lines rl
                    WHERE rl.source_type='ADVANCE_REPAYMENT' AND rl.source_id=ar2.id),0))
                     FROM advance_repayments ar2 WHERE ar2.advance_id=a.id
                 ),0),0)<=0.009 THEN a.repayment_status IS DISTINCT FROM 'SETTLED'
                 ELSE a.repayment_status IS DISTINCT FROM 'OPEN'
               END
             )::int AS status_mismatch_count
        FROM advance_repayments ar
        JOIN advance_requests a ON a.id=ar.advance_id
        LEFT JOIN employee_earnings_settlements es ON es.id=ar.settlement_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS ledger_count,MIN(x.employee_id::text)::uuid AS employee_id,
                 COALESCE(SUM(x.credit_amount),0) AS credit_amount,
                 COALESCE(SUM(x.debit_amount),0) AS debit_amount
            FROM employee_earnings_ledger x WHERE x.advance_repayment_id=ar.id
        ) el ON TRUE
       WHERE ar.source_worker_payment_id=wp.id OR es.worker_payment_id=wp.id
    ) repayments ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,COALESCE(SUM(line.amount),0) AS amount_total
        FROM financial_reversal_lines line
        JOIN advance_repayments ar ON ar.id=line.source_id
        LEFT JOIN employee_earnings_settlements es ON es.id=ar.settlement_id
       WHERE line.source_type='ADVANCE_REPAYMENT'
         AND (ar.source_worker_payment_id=wp.id OR es.worker_payment_id=wp.id)
         AND line.reversal_id IN (SELECT parent_line.reversal_id FROM financial_reversal_lines parent_line
           WHERE parent_line.source_type='WORKER_PAYMENT' AND parent_line.source_id=wp.id)
    ) repayment_reversal ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT e.id)::int AS row_count,
             COALESCE(SUM(e.amount),0) AS amount_total,
             COUNT(DISTINCT e.paid_from_employee_id)::int AS holder_count,
             COUNT(*) FILTER(WHERE e.paid_from_employee_id IS NOT NULL)::int AS holder_row_count,
             COUNT(*) FILTER(WHERE e.cash_custody_transaction_id IS NOT NULL)::int AS custody_link_count,
             COUNT(*) FILTER(WHERE e.paid_from_employee_id IS NOT NULL AND (
               e.cash_custody_transaction_id IS NULL OR NOT EXISTS(
                 SELECT 1 FROM cash_custody_transactions linked
                  WHERE linked.id=e.cash_custody_transaction_id
                    AND linked.source_type='WORKER_PAYMENT' AND linked.source_id=wp.id
                    AND linked.direction='OUT' AND linked.employee_id=e.paid_from_employee_id
                    AND ABS(linked.amount-wp.amount)<=0.01
               )
             ))::int AS custody_link_mismatch_count,
             MIN(e.paid_from_employee_id::text) AS holder_id
        FROM accounting_expenses e
       WHERE e.source_worker_payment_id=wp.id
          OR (e.source_worker_payment_id IS NULL AND e.idempotency_key=wp.idempotency_key)
    ) expenses ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS out_count,COALESCE(SUM(c.amount),0) AS out_amount,
             COUNT(DISTINCT c.employee_id)::int AS holder_count,
             MIN(c.employee_id::text) AS holder_id
        FROM cash_custody_transactions c
       WHERE c.source_type='WORKER_PAYMENT' AND c.source_id=wp.id AND c.direction='OUT'
    ) custody ON TRUE
    LEFT JOIN LATERAL (
      WITH source_allocations AS (
        SELECT a.id,a.amount,'EMPLOYEE_EARNINGS_SETTLEMENT'::text AS source,p.employee_id,p.status
          FROM employee_earnings_settlement_allocations a
          JOIN employee_earnings_settlements es ON es.id=a.settlement_id
          JOIN production_entries p ON p.id=a.production_entry_id
         WHERE es.worker_payment_id=wp.id
        UNION ALL
        SELECT a.id,a.amount,'WORKER_PAYMENT_ORDER'::text,p.employee_id,p.status
          FROM worker_payment_order_allocations a
          JOIN production_entries p ON p.id=a.production_entry_id
         WHERE a.worker_payment_id=wp.id
           AND (
             NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es
               JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id
               WHERE es.worker_payment_id=wp.id)
             OR EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events ev
               WHERE ev.worker_payment_order_allocation_id=a.id AND ev.event_type='ALLOCATED_TO_PRODUCTION')
           )
        UNION ALL
        SELECT a.id,a.amount,'WORKER_PAYMENT_LEGACY'::text,p.employee_id,p.status
          FROM worker_payment_allocations a
          JOIN production_entries p ON p.id=a.production_entry_id
         WHERE a.worker_payment_id=wp.id
           AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es
             JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id
             WHERE es.worker_payment_id=wp.id)
           AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
      )
      SELECT COUNT(*)::int AS source_count,
             COUNT(*) FILTER(WHERE sa.employee_id IS DISTINCT FROM wp.employee_id OR sa.status IS DISTINCT FROM 'APPROVED')::int AS mismatch_count,
             COALESCE(SUM(sa.amount),0) AS source_amount,
             COALESCE(SUM(GREATEST(sa.amount-COALESCE((SELECT SUM(r.amount) FROM worker_payment_allocation_reversals r
               WHERE r.worker_payment_id=wp.id AND r.source_allocation_id=sa.id AND r.allocation_source=sa.source),0),0)),0) AS active_amount,
             (SELECT COUNT(*)::int FROM worker_payment_allocation_reversals r WHERE r.worker_payment_id=wp.id) AS reversal_count,
             (SELECT COALESCE(SUM(r.amount),0) FROM worker_payment_allocation_reversals r WHERE r.worker_payment_id=wp.id) AS reversal_amount
        FROM source_allocations sa
    ) allocations ON TRUE
    LEFT JOIN LATERAL (
      SELECT d.original_amount,
             COALESCE(SUM(ev.amount) FILTER(WHERE ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
               AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv
                 WHERE rv.reverses_event_id=ev.id AND rv.event_type='REVERSED')),0) AS active_amount,
             COUNT(*) FILTER(WHERE ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER'))::int AS source_event_count,
             COUNT(*) FILTER(WHERE ev.event_type='REVERSED')::int AS reversed_event_count,
             COUNT(*) FILTER(WHERE ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
               AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv
                 WHERE rv.reverses_event_id=ev.id AND rv.event_type='REVERSED'))::int AS active_event_count
        FROM worker_payment_settlement_differences d
        LEFT JOIN worker_payment_settlement_difference_events ev ON ev.difference_id=d.id
       WHERE d.worker_payment_id=wp.id
       GROUP BY d.id
    ) difference ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,COALESCE(SUM(line.amount),0) AS amount_total,
             MIN(line.reversal_id::text)::uuid AS reversal_id
        FROM financial_reversal_lines line
       WHERE line.source_type='WORKER_PAYMENT' AND line.source_id=wp.id
    ) parent_reversal ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,COALESCE(SUM(er.amount),0) AS amount_total
        FROM accounting_expense_reversals er
       WHERE er.source_worker_payment_id=wp.id
          OR er.expense_id IN (SELECT e.id FROM accounting_expenses e
             WHERE e.source_worker_payment_id=wp.id
                OR (e.source_worker_payment_id IS NULL AND e.idempotency_key=wp.idempotency_key))
    ) expense_reversal ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,COALESCE(SUM(c.amount),0) AS amount_total,
             COUNT(DISTINCT c.employee_id)::int AS holder_count,
             MIN(c.employee_id::text) AS holder_id
        FROM cash_custody_transactions c
       WHERE c.source_type='FINANCIAL_REVERSAL' AND c.direction='IN'
         AND c.source_id IN (SELECT line.reversal_id FROM financial_reversal_lines line
           WHERE line.source_type='WORKER_PAYMENT' AND line.source_id=wp.id)
    ) custody_reversal ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,
             COALESCE(SUM(l.credit_amount),0) AS credit_total,
             COALESCE(SUM(l.debit_amount),0) AS debit_total,
             COUNT(*) FILTER(WHERE l.employee_id IS DISTINCT FROM wp.employee_id)::int AS wrong_employee_count
        FROM employee_earnings_ledger l
       WHERE l.financial_reversal_id IN (SELECT line.reversal_id FROM financial_reversal_lines line
         WHERE line.source_type='WORKER_PAYMENT' AND line.source_id=wp.id)
    ) reversal_ledger ON TRUE
    ORDER BY wp.created_at,wp.id
  `);

  const issues: ReconciliationIssue[] = [];
  const counts: Record<string, number> = {};
  const add = (row: Record<string, any>, issueType: string, expected: number | string | null, actual: number | string | null) => {
    const issue: ReconciliationIssue = {
      workerPaymentId: String(row.worker_payment_id),
      employeeId: String(row.employee_id),
      employeeCode: String(row.employee_code ?? ""),
      employeeName: String(row.employee_name ?? ""),
      issueType,
      expected,
      actual,
      details: {
        grossAmount: amount(row.gross_amount),
        cashPaidAmount: amount(row.cash_paid_amount),
        advanceRepaymentAmount: amount(row.advance_repayment_amount)
      }
    };
    issues.push(issue);
    counts[issueType] = (counts[issueType] ?? 0) + 1;
  };

  for (const row of result.rows) {
    const reversed = amount(row.parent_reversal_count) > 0;
    if (!near(row.gross_amount, amount(row.cash_paid_amount) + amount(row.advance_repayment_amount))) {
      add(row, "PAYMENT_TOTAL_MISMATCH", amount(row.cash_paid_amount) + amount(row.advance_repayment_amount), amount(row.gross_amount));
    }

    if (!reversed) {
      if (amount(row.settlement_count) !== 1 || amount(row.settlement_mismatch_count) > 0) {
        add(row, "SETTLEMENT_LINK_MISMATCH", 1, row.settlement_count);
      }
      if (amount(row.ledger_count) !== 1 || amount(row.ledger_wrong_employee_count) > 0 ||
          amount(row.ledger_settlement_link_mismatch_count) > 0 ||
          !near(row.ledger_debit, row.gross_amount) || !near(row.ledger_credit, 0)) {
        add(row, "EARNINGS_LEDGER_MISMATCH", row.gross_amount, row.ledger_debit);
      }
      if (!near(row.repayment_total, row.advance_repayment_amount) ||
          amount(row.repayment_mismatch_count) > 0) {
        add(row, "ADVANCE_REPAYMENT_MISMATCH", row.advance_repayment_amount, row.repayment_total);
      }
      if (amount(row.expense_count) < 1 || !near(row.expense_total, row.gross_amount)) {
        add(row, "WORKER_PAYMENT_EXPENSE_MISMATCH", row.gross_amount, row.expense_total);
      }
      const cash = amount(row.cash_paid_amount);
      const custodyCount = amount(row.custody_out_count);
      const previousCustody = row.previous_custody === true;
      const requiresCashCustodyOut = cash > 0.009 && !previousCustody;
      const custodyMovementValid = requiresCashCustodyOut
        ? custodyCount === 1 && near(row.custody_out_amount, cash) && amount(row.custody_out_holder_count) === 1
        : custodyCount === 0;
      const expenseCustodyLinkValid = requiresCashCustodyOut
        ? amount(row.expense_holder_count) === 1 &&
          amount(row.expense_holder_row_count) === 1 &&
          amount(row.expense_custody_link_count) === 1 &&
          amount(row.expense_custody_link_mismatch_count) === 0 &&
          row.custody_out_holder_id === row.expense_holder_id
        : amount(row.expense_holder_count) === 0 &&
          amount(row.expense_holder_row_count) === 0 &&
          amount(row.expense_custody_link_count) === 0;
      if (!custodyMovementValid) {
        add(row, "CASH_CUSTODY_MISMATCH", requiresCashCustodyOut ? cash : 0, row.custody_out_amount);
      }
      if (!expenseCustodyLinkValid) {
        add(row, "WORKER_PAYMENT_EXPENSE_CUSTODY_LINK_MISMATCH", requiresCashCustodyOut ? 1 : 0, row.expense_custody_link_count);
      }
      if (amount(row.allocation_mismatch_count) > 0 ||
          amount(row.allocation_amount) > amount(row.gross_amount) + 0.01 ||
          amount(row.allocation_reversal_count) > amount(row.allocation_count) ||
          amount(row.allocation_reversal_amount) > amount(row.allocation_source_amount) + 0.01) {
        add(row, "PRODUCTION_ALLOCATION_MISMATCH", row.gross_amount, row.allocation_amount);
      }
      if (amount(row.difference_original_amount) > amount(row.gross_amount) + 0.01 ||
          amount(row.difference_active_amount) > amount(row.difference_original_amount) + 0.01) {
        add(row, "SETTLEMENT_DIFFERENCE_MISMATCH", row.difference_original_amount, row.difference_active_amount);
      }
    } else {
      if (amount(row.parent_reversal_count) !== 1 || !near(row.parent_reversal_amount, row.gross_amount) ||
          amount(row.expense_reversal_count) !== amount(row.expense_count) ||
          !near(row.expense_reversal_amount, row.gross_amount)) {
        add(row, "WORKER_PAYMENT_REVERSAL_MISMATCH", row.gross_amount, row.parent_reversal_amount);
      }
      const expectedCustodyReversal = row.previous_custody ? 0 : amount(row.cash_paid_amount);
      const expectedCustodyReversalCount = expectedCustodyReversal > 0.009 ? 1 : 0;
      const originalCustodyValid = row.previous_custody
        ? amount(row.custody_out_count) === 0
        : expectedCustodyReversal > 0.009
          ? amount(row.custody_out_count) === 1 && near(row.custody_out_amount, expectedCustodyReversal) &&
            amount(row.custody_out_holder_count) === 1
          : amount(row.custody_out_count) === 0;
      const reversalCustodyHolderValid = expectedCustodyReversal > 0.009
        ? amount(row.custody_reversal_holder_count) === 1 &&
          row.custody_reversal_holder_id === row.custody_out_holder_id
        : amount(row.custody_reversal_holder_count) === 0;
      if (amount(row.custody_reversal_count) !== expectedCustodyReversalCount ||
          !near(row.custody_reversal_in, expectedCustodyReversal) ||
          !originalCustodyValid || !reversalCustodyHolderValid) {
        add(row, "WORKER_PAYMENT_CUSTODY_REVERSAL_MISMATCH", row.cash_paid_amount, row.custody_reversal_in);
      }
      if (amount(row.reversal_ledger_count) !== 1 + amount(row.repayment_count) ||
          !near(row.reversal_ledger_credit, row.gross_amount) ||
          !near(row.reversal_ledger_debit, row.advance_repayment_amount) ||
          amount(row.reversal_ledger_wrong_employee_count) > 0 ||
          amount(row.repayment_reversal_count) !== amount(row.repayment_count) ||
          !near(row.repayment_reversal_amount, row.advance_repayment_amount)) {
        add(row, "WORKER_PAYMENT_REVERSAL_LEDGER_MISMATCH", row.gross_amount, row.reversal_ledger_credit);
      }
      if (amount(row.allocation_reversal_count) !== amount(row.allocation_count) ||
          !near(row.allocation_reversal_amount, row.allocation_source_amount)) {
        add(row, "WORKER_PAYMENT_REVERSAL_ALLOCATIONS_MISMATCH", row.allocation_source_amount, row.allocation_reversal_amount);
      }
      if (amount(row.difference_active_event_count) > 0 ||
          amount(row.difference_reversed_event_count) !== amount(row.difference_source_event_count)) {
        add(row, "WORKER_PAYMENT_REVERSAL_DIFFERENCE_EVENTS_ACTIVE", row.difference_source_event_count, row.difference_reversed_event_count);
      }
    }
    if (amount(row.advance_status_mismatch_count) > 0) {
      add(row, "ADVANCE_REPAYMENT_MISMATCH", "OPEN/SETTLED حسب الرصيد المتبقي", `${amount(row.advance_status_mismatch_count)} سلفة بحالة غير مطابقة`);
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    paymentCount: result.rows.length,
    issueCount: issues.length,
    counts,
    issues
  };
}
