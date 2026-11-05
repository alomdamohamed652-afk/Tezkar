ALTER TABLE payroll_payments
  ADD COLUMN IF NOT EXISTS settlement_source text NOT NULL DEFAULT 'CURRENT_CUSTODY';

ALTER TABLE payroll_payments
  DROP CONSTRAINT IF EXISTS payroll_payments_settlement_source_check;

ALTER TABLE payroll_payments
  ADD CONSTRAINT payroll_payments_settlement_source_check
  CHECK (settlement_source IN ('CURRENT_CUSTODY', 'PREVIOUS_CUSTODY'));
