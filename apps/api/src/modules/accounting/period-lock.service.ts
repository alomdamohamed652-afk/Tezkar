import type { PoolClient } from "pg";
import { AppError } from "../../http/errors.js";

/**
 * Prevent ordinary financial postings inside a period that has entered review
 * or has been closed. The shared row lock serializes postings against close.
 */
export async function assertAccountingPeriodOpen(client: PoolClient, date?: string | null): Promise<void> {
  const period = await client.query(
    "SELECT id,status FROM accounting_periods WHERE COALESCE($1::date,current_date) BETWEEN period_start AND period_end ORDER BY period_start LIMIT 1 FOR SHARE",
    [date ?? null]
  );
  if (period.rows[0] && period.rows[0].status !== "OPEN") {
    throw new AppError(
      "ACCOUNTING_PERIOD_CLOSED",
      "الفترة المالية ليست مفتوحة؛ لا يمكن تسجيل حركة مالية عادية عليها. استخدم إجراء التصحيح المعتمد.",
      409
    );
  }
}

/** Monthly payroll changes affect the full calendar month, not just its first day. */
export async function assertAccountingMonthOpen(client: PoolClient, monthDate: string): Promise<void> {
  // Lock every period overlapping this month, including OPEN periods, so a
  // concurrent close cannot pass the posting check between validation and commit.
  const period = await client.query(
    "SELECT id,status FROM accounting_periods WHERE period_start <= (date_trunc('month',$1::date) + interval '1 month - 1 day')::date AND period_end >= date_trunc('month',$1::date)::date ORDER BY period_start FOR SHARE",
    [monthDate]
  );
  if (period.rows.some((row: {status:string}) => row.status !== "OPEN")) {
    throw new AppError(
      "ACCOUNTING_PERIOD_CLOSED",
      "شهر الرواتب يتداخل مع فترة مالية قيد المراجعة أو مقفولة؛ لا يمكن تعديل مستحقاته.",
      409
    );
  }
}
