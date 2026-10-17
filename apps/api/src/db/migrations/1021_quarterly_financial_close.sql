-- Add an auditable two-person review and manual rollover to accounting periods.
ALTER TABLE accounting_periods
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closing_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS opening_balance_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollover_source_period_id UUID REFERENCES accounting_periods(id),
  ADD COLUMN IF NOT EXISTS last_reopened_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reopen_reason TEXT;

CREATE INDEX IF NOT EXISTS accounting_periods_rollover_source_idx
  ON accounting_periods (rollover_source_period_id)
  WHERE rollover_source_period_id IS NOT NULL;

COMMENT ON COLUMN accounting_periods.closing_snapshot IS
  'Immutable financial close snapshot captured when the manager closes this period.';
COMMENT ON COLUMN accounting_periods.opening_balance_snapshot IS
  'Opening balances copied once from the immediately preceding closed period snapshot; not a new cash movement.';

-- Guard date-based posting APIs and direct SQL writes from mutating a closed period.
CREATE OR REPLACE FUNCTION prevent_closed_financial_period_write() RETURNS trigger AS $$
DECLARE effective_date DATE;
BEGIN
  IF TG_TABLE_NAME = 'accounting_expenses' THEN
    effective_date := COALESCE(NEW.expense_date, CURRENT_DATE);
  ELSIF TG_TABLE_NAME = 'order_revenues' THEN
    effective_date := COALESCE(NEW.revenue_date, CURRENT_DATE);
  ELSIF TG_TABLE_NAME = 'cash_custody_transactions' THEN
    effective_date := COALESCE(NEW.transaction_date, CURRENT_DATE);
  ELSIF TG_TABLE_NAME = 'production_entries' THEN
    effective_date := COALESCE(NEW.work_date, CURRENT_DATE);
  ELSIF TG_TABLE_NAME = 'employee_earnings_settlements' THEN
    effective_date := COALESCE(NEW.settlement_date, CURRENT_DATE);
  ELSIF TG_TABLE_NAME = 'advance_repayments' THEN
    effective_date := COALESCE(NEW.payment_date, CURRENT_DATE);
  ELSE
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM accounting_periods p
    WHERE p.status = 'CLOSED'
      AND effective_date BETWEEN p.period_start AND p.period_end
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_CLOSED: ordinary writes are blocked for a closed financial period'
      USING ERRCODE = '23514', CONSTRAINT = 'financial_period_closed_write';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounting_expenses_closed_period_guard ON accounting_expenses;
CREATE TRIGGER accounting_expenses_closed_period_guard
  BEFORE INSERT OR UPDATE ON accounting_expenses
  FOR EACH ROW EXECUTE FUNCTION prevent_closed_financial_period_write();
DROP TRIGGER IF EXISTS order_revenues_closed_period_guard ON order_revenues;
CREATE TRIGGER order_revenues_closed_period_guard
  BEFORE INSERT OR UPDATE ON order_revenues
  FOR EACH ROW EXECUTE FUNCTION prevent_closed_financial_period_write();
DROP TRIGGER IF EXISTS cash_custody_closed_period_guard ON cash_custody_transactions;
CREATE TRIGGER cash_custody_closed_period_guard
  BEFORE INSERT OR UPDATE ON cash_custody_transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_closed_financial_period_write();
DROP TRIGGER IF EXISTS production_entries_closed_period_guard ON production_entries;
CREATE TRIGGER production_entries_closed_period_guard
  BEFORE INSERT OR UPDATE ON production_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_closed_financial_period_write();
DROP TRIGGER IF EXISTS earnings_settlements_closed_period_guard ON employee_earnings_settlements;
CREATE TRIGGER earnings_settlements_closed_period_guard
  BEFORE INSERT OR UPDATE ON employee_earnings_settlements
  FOR EACH ROW EXECUTE FUNCTION prevent_closed_financial_period_write();
DROP TRIGGER IF EXISTS advance_repayments_closed_period_guard ON advance_repayments;
CREATE TRIGGER advance_repayments_closed_period_guard
  BEFORE INSERT OR UPDATE ON advance_repayments
  FOR EACH ROW EXECUTE FUNCTION prevent_closed_financial_period_write();
