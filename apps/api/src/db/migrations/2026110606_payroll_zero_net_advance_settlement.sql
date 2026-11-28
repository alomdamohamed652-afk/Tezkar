-- Source-key the non-cash payroll offset so a zero-net payroll can settle
-- salary advances without fabricating a payroll payment or cash-custody movement.
ALTER TABLE employee_earnings_ledger
  ADD COLUMN IF NOT EXISTS payroll_advance_offset_item_id UUID
  REFERENCES payroll_items(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_payroll_advance_offset_item
  ON employee_earnings_ledger(payroll_advance_offset_item_id)
  WHERE payroll_advance_offset_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_source_payroll_item_advance
  ON advance_repayments(source_payroll_item_id,advance_id)
  WHERE source_payroll_item_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('2026110606_payroll_zero_net_advance_settlement')
ON CONFLICT(version) DO NOTHING;
