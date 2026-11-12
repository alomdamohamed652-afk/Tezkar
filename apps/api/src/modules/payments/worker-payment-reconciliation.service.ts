import { pool } from "../../db/pool.js";

type ReconciliationIssue = {
  workerPaymentId: string;
  employeeId: string;
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
      COALESCE(repayments.row_count,0) AS repayment_count,
      COALESCE(repayments.amount_total,0) AS repayment_total,
      COALESCE(repayments.mismatch_count,0) AS repayment_mismatch_count,
      COALESCE(expenses.row_count,0) AS expense_count,
      COALESCE(expenses.amount_total,0) AS expense_total,
      COALESCE(expenses.holder_count,0) AS expense_holder_count,
      expenses.holder_id AS expense_holder_id,
      COALESCE(custody.out_count,0) AS custody_out_count,
      COALESCE(custody.out_amount,0) AS custody_out_amount,
      COALESCE(custody.holder_count,0) AS custody_out_holder_count,
      custody.holder_id AS custody_out_holder_id,
      COALESCE(allocations.source_count,0) AS allocation_count,
      COALESCE(allocations.source_amount,0) AS allocation_amount,
      COALESCE(allocations.reversal_count,0) AS allocation_reversal_count,
      COALESCE(allocations.reversal_amount,0) AS allocation_reversal_amount,
      COALESCE(difference.original_amount,0) AS difference_original_amount,
      COALESCE(difference.active_amount,0) AS difference_active_amount,
      COALESCE(difference.reversed_event_count,0) AS difference_reversed_event_count,
      COALESCE(parent_reversal.row_count,0) AS parent_reversal_count,
      COALESCE(parent_reversal.amount_total,0) AS parent_reversal_amount,
      COALESCE(expense_reversal.amount_total,0) AS expense_reversal_amount,
      COALESCE(expense_reversal.row_count,0) AS expense_reversal_count,
      COALESCE(custody_reversal.amount_total,0) AS custody_reversal_in,
      COALESCE(reversal_ledger.credit_total,0) AS reversal_ledger_credit,
      COALESCE(reversal_ledger.debit_total,0) AS reversal_ledger_debit,
      COALESCE(difference.active_event_count,0) AS difference_active_event_count
    FROM worker_payments wp
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
             COUNT(*) FILTER(WHERE l.employee_id IS DISTINCT FROM wp.employee_id)::int AS wrong_employee_count
        FROM employee_earnings_ledger l WHERE l.worker_payment_id=wp.id
    ) ledger ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS row_count,
             COALESCE(SUM(ar.amount),0) AS amount_total,
             COUNT(*) FILTER(WHERE a.employee_id IS DISTINCT FROM wp.employee_id
               OR el.ledger_count<>1
               OR el.employee_id IS DISTINCT FROM wp.employee_id
               OR ABS(el.credit_amount-ar.amount)>0.01
               OR ABS(el.debit_amount)>0.01)::int AS mismatch_count
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
      SELECT COUNT(DISTINCT e.id)::int AS row_count,
             COALESCE(SUM(e.amount),0) AS amount_total,
             COUNT(DISTINCT e.paid_from_employee_id)::int AS holder_count,
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
        SELECT a.id,a.amount,'EMPLOYEE_EARNINGS_SETTLEMENT'::text AS source
          FROM employee_earnings_settlement_allocations a
          JOIN employee_earnings_settlements es ON es.id=a.settlement_id
         WHERE es.worker_payment_id=wp.id
        UNION ALL
        SELECT a.id,a.amount,'WORKER_PAYMENT_ORDER'::text
          FROM worker_payment_order_allocations a
         WHERE a.worker_payment_id=wp.id
           AND (
             NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es
               JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id
               WHERE es.worker_payment_id=wp.id)
             OR EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events ev
               WHERE ev.worker_payment_order_allocation_id=a.id AND ev.event_type='ALLOCATED_TO_PRODUCTION')
           )
        UNION ALL
        SELECT a.id,a.amount,'WORKER_PAYMENT_LEGACY'::text
          FROM worker_payment_allocations a
         WHERE a.worker_payment_id=wp.id
           AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements es
             JOIN employee_earnings_settlement_allocations esa ON esa.settlement_id=es.id
             WHERE es.worker_payment_id=wp.id)
           AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations oa WHERE oa.worker_payment_id=wp.id)
      )
      SELECT COUNT(*)::int AS source_count,COALESCE(SUM(sa.amount),0) AS source_amount,
             (SELECT COUNT(*)::int FROM worker_payment_allocation_reversals r WHERE r.worker_payment_id=wp.id) AS reversal_count,
             (SELECT COALESCE(SUM(r.amount),0) FROM worker_payment_allocation_reversals r WHERE r.worker_payment_id=wp.id) AS reversal_amount
        FROM source_allocations sa
    ) allocations ON TRUE
    LEFT JOIN LATERAL (
      SELECT d.original_amount,
             COALESCE(SUM(ev.amount) FILTER(WHERE ev.event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER')
               AND NOT EXISTS(SELECT 1 FROM worker_payment_settlement_difference_events rv
                 WHERE rv.reverses_event_id=ev.id AND rv.event_type='REVERSED')),0) AS active_amount,
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
      SELECT COALESCE(SUM(c.amount),0) AS amount_total
        FROM cash_custody_transactions c
       WHERE c.source_type='FINANCIAL_REVERSAL' AND c.direction='IN'
         AND c.source_id IN (SELECT line.reversal_id FROM financial_reversal_lines line
           WHERE line.source_type='WORKER_PAYMENT' AND line.source_id=wp.id)
    ) custody_reversal ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l.credit_amount),0) AS credit_total,
             COALESCE(SUM(l.debit_amount),0) AS debit_total
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
      const custodyValid = cash <= 0.009
        ? custodyCount === 0
        : previousCustody
          ? custodyCount === 0 && amount(row.expense_holder_count) === 0
          : custodyCount === 1 && near(row.custody_out_amount, cash) &&
            amount(row.custody_out_holder_count) === 1 &&
            amount(row.expense_holder_count) === 1 &&
            row.custody_out_holder_id === row.expense_holder_id;
      if (!custodyValid) {
        add(row, "CASH_CUSTODY_MISMATCH", cash, row.custody_out_amount);
      }
      if (amount(row.allocation_amount) > amount(row.gross_amount) + 0.01 ||
          amount(row.allocation_reversal_amount) > amount(row.allocation_amount) + 0.01) {
        add(row, "PRODUCTION_ALLOCATION_MISMATCH", row.gross_amount, row.allocation_amount);
      }
      if (amount(row.difference_active_amount) > amount(row.difference_original_amount) + 0.01) {
        add(row, "SETTLEMENT_DIFFERENCE_MISMATCH", row.difference_original_amount, row.difference_active_amount);
      }
    } else {
      if (!near(row.parent_reversal_amount, row.gross_amount) ||
          !near(row.expense_reversal_amount, row.gross_amount)) {
        add(row, "WORKER_PAYMENT_REVERSAL_MISMATCH", row.gross_amount, row.parent_reversal_amount);
      }
      if (!near(row.custody_reversal_in, row.cash_paid_amount) && !row.previous_custody) {
        add(row, "WORKER_PAYMENT_CUSTODY_REVERSAL_MISMATCH", row.cash_paid_amount, row.custody_reversal_in);
      }
      if (!near(row.reversal_ledger_credit, row.gross_amount) ||
          !near(row.reversal_ledger_debit, row.advance_repayment_amount)) {
        add(row, "WORKER_PAYMENT_REVERSAL_LEDGER_MISMATCH", row.gross_amount, row.reversal_ledger_credit);
      }
      if (amount(row.difference_active_event_count) > 0) {
        add(row, "WORKER_PAYMENT_REVERSAL_DIFFERENCE_EVENTS_ACTIVE", 0, row.difference_active_event_count);
      }
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
