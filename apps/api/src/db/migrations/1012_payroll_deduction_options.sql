-- Configurable payroll deduction calculation, with legacy rows preserved as fixed amounts.
ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS deduction_mode TEXT NOT NULL DEFAULT 'FIXED'
    CHECK (deduction_mode IN ('FIXED','PERCENTAGE')),
  ADD COLUMN IF NOT EXISTS deduction_percentage NUMERIC(7,4),
  ADD COLUMN IF NOT EXISTS deduction_basis TEXT NOT NULL DEFAULT 'BASE_SALARY'
    CHECK (deduction_basis IN ('BASE_SALARY','BASE_PLUS_BONUS'));

ALTER TABLE payroll_items
  ADD CONSTRAINT payroll_items_deduction_percentage_range
  CHECK (deduction_percentage IS NULL OR (deduction_percentage >= 0 AND deduction_percentage <= 100));

ALTER TABLE payroll_items
  ADD CONSTRAINT payroll_items_percentage_mode_requires_percentage
  CHECK (deduction_mode <> 'PERCENTAGE' OR deduction_percentage IS NOT NULL);

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version)
VALUES ('1012_payroll_deduction_options')
ON CONFLICT(version) DO NOTHING;
