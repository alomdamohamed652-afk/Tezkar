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
