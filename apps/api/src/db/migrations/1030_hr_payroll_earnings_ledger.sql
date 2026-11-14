-- Link earnings ledger entries to their source records so salary accruals and payouts
-- are idempotent and the employee balance can show earned-but-unpaid salary.
ALTER TABLE employee_earnings_ledger
  ADD COLUMN IF NOT EXISTS payroll_item_id UUID REFERENCES payroll_items(id),
  ADD COLUMN IF NOT EXISTS payroll_payment_id UUID REFERENCES payroll_payments(id),
  ADD COLUMN IF NOT EXISTS advance_repayment_id UUID REFERENCES advance_repayments(id),
  ADD COLUMN IF NOT EXISTS settlement_id UUID REFERENCES employee_earnings_settlements(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_ledger_payroll_item
  ON employee_earnings_ledger(payroll_item_id)
  WHERE payroll_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_ledger_payroll_payment
  ON employee_earnings_ledger(payroll_payment_id)
  WHERE payroll_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_ledger_advance_repayment
  ON employee_earnings_ledger(advance_repayment_id)
  WHERE advance_repayment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_ledger_settlement
  ON employee_earnings_ledger(settlement_id)
  WHERE settlement_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1030_hr_payroll_earnings_ledger')
ON CONFLICT(version) DO NOTHING;
