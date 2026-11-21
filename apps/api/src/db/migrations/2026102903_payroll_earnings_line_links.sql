-- Link each approved payroll adjustment to its employee earnings ledger posting.
ALTER TABLE employee_earnings_ledger
  ADD COLUMN IF NOT EXISTS payroll_adjustment_line_id UUID
  REFERENCES payroll_adjustment_lines(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_payroll_adjustment_line
  ON employee_earnings_ledger(payroll_adjustment_line_id)
  WHERE payroll_adjustment_line_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('2026102903_payroll_earnings_line_links')
ON CONFLICT (version) DO NOTHING;
