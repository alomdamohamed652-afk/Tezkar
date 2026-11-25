import { AppError } from "../../http/errors.js";

type Db = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/**
 * Rebuild the salary-component adjustment lines of a DRAFT payroll period from
 * each employee's active components (مفردات المرتب الثابتة), then recompute
 * item totals from all ACTIVE lines (manual + component-generated).
 *
 * Only component-generated lines (salary_component_id IS NOT NULL) are replaced;
 * manual lines added by a manager stay untouched. Called during draft generation
 * and regeneration; the caller owns the transaction and the DRAFT check.
 */
export async function applySalaryComponentsToDraft(client: Db, periodId: string, createdBy: string): Promise<number> {
  // Same-name same-type components whose ranges do not overlap can still both touch
  // one payroll month (old ends June 15, new starts June 16). Applying both in full
  // would double-charge, and no source rule picks a winner — reject instead.
  const ambiguous = await client.query(
    `SELECT e.full_name, c.name
       FROM payroll_periods p
       JOIN payroll_items i ON i.period_id=p.id
       JOIN employees e ON e.id=i.employee_id
       JOIN employee_salary_components c ON c.employee_id=i.employee_id AND c.is_active=TRUE
        AND c.effective_from < (p.period_month + INTERVAL '1 month')::date
        AND (c.effective_to IS NULL OR c.effective_to >= p.period_month)
      WHERE p.id=$1
      GROUP BY e.full_name, c.line_type, c.name
      HAVING COUNT(*)>1
      ORDER BY e.full_name, c.name LIMIT 3`,
    [periodId]
  );
  if (ambiguous.rows.length) {
    const names = ambiguous.rows.map((row) => row.full_name + " (" + row.name + ")").join("، ");
    throw new AppError(
      "SALARY_COMPONENT_AMBIGUOUS_MONTH",
      "فيه أكثر من مفردة نشطة بنفس الاسم والنوع بتتقاطع مع شهر المسير لـ: " + names + ". عدّل فترات السريان أو الأسماء قبل توليد المسير.",
      422
    );
  }
  await client.query(
    `DELETE FROM payroll_adjustment_lines
     WHERE salary_component_id IS NOT NULL
       AND payroll_item_id IN (SELECT id FROM payroll_items WHERE period_id=$1)`,
    [periodId]
  );
  const inserted = await client.query(
    `INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,notes,created_by,salary_component_id)
     SELECT i.id,c.line_type,c.name,c.amount,c.notes,$2,c.id
       FROM payroll_items i
       JOIN payroll_periods p ON p.id=i.period_id
       JOIN employee_salary_components c ON c.employee_id=i.employee_id AND c.is_active=TRUE
        AND c.effective_from < (p.period_month + INTERVAL '1 month')::date
        AND (c.effective_to IS NULL OR c.effective_to >= p.period_month)
      WHERE i.period_id=$1
     RETURNING id`,
    [periodId, createdBy]
  );
  await client.query(
    `UPDATE payroll_items i SET
       bonus_amount=t.bonus,
       deduction_amount=t.deduction
     FROM (
       SELECT payroll_item_id,
         COALESCE(SUM(amount) FILTER (WHERE line_type='BONUS'),0) AS bonus,
         COALESCE(SUM(amount) FILTER (WHERE line_type='DEDUCTION'),0) AS deduction
       FROM payroll_adjustment_lines
       WHERE status='ACTIVE' AND payroll_item_id IN (SELECT id FROM payroll_items WHERE period_id=$1)
       GROUP BY payroll_item_id
     ) t
     WHERE i.id=t.payroll_item_id AND i.period_id=$1`,
    [periodId]
  );
  // payroll_items enforces base_salary + bonus_amount >= deduction_amount; turn a
  // violation into a readable error naming the employee instead of a raw 500.
  const violations = await client.query(
    `SELECT e.full_name FROM payroll_items i JOIN employees e ON e.id=i.employee_id
     WHERE i.period_id=$1 AND i.base_salary + i.bonus_amount < i.deduction_amount
     ORDER BY e.full_name LIMIT 3`,
    [periodId]
  );
  if (violations.rows.length) {
    const names = violations.rows.map((row) => row.full_name).join("، ");
    throw new AppError(
      "SALARY_COMPONENTS_EXCEED_SALARY",
      "مفردات الخصم الثابتة أكبر من الراتب والمكافآت لـ: " + names + ". راجع مفردات المرتب قبل توليد المسير.",
      422
    );
  }
  return inserted.rowCount ?? inserted.rows.length;
}
