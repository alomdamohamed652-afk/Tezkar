-- Automatic advance recovery from monthly payroll and approved production.
-- Keep employee take-home pay separate from the salary expense amount.
ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS advance_repayment_amount NUMERIC(18,2) NOT NULL DEFAULT 0
    CHECK (advance_repayment_amount >= 0);

ALTER TABLE payroll_items DROP COLUMN net_amount;
ALTER TABLE payroll_items
  ADD COLUMN net_amount NUMERIC(18,2)
    GENERATED ALWAYS AS (base_salary + bonus_amount - deduction_amount - advance_repayment_amount) STORED;

ALTER TABLE payroll_items DROP CONSTRAINT IF EXISTS payroll_items_check;
ALTER TABLE payroll_items
  ADD CONSTRAINT payroll_items_total_deductions_check
  CHECK (base_salary + bonus_amount >= deduction_amount + advance_repayment_amount);

CREATE TABLE IF NOT EXISTS payroll_advance_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_item_id UUID NOT NULL REFERENCES payroll_items(id) ON DELETE RESTRICT,
  advance_id UUID NOT NULL REFERENCES advance_requests(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  repayment_type TEXT NOT NULL DEFAULT 'FIXED_INSTALLMENT'
    CHECK (repayment_type = 'FIXED_INSTALLMENT'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(payroll_item_id, advance_id)
);

ALTER TABLE advance_repayments
  ADD COLUMN IF NOT EXISTS source_production_entry_id UUID REFERENCES production_entries(id),
  ADD COLUMN IF NOT EXISTS source_payroll_item_id UUID REFERENCES payroll_items(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_source_production
  ON advance_repayments(source_production_entry_id)
  WHERE source_production_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_source_payroll_item
  ON advance_repayments(source_payroll_item_id)
  WHERE source_payroll_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payroll_advance_deductions_advance
  ON payroll_advance_deductions(advance_id, payroll_item_id);

INSERT INTO schema_migrations(version)
VALUES ('1015_advance_repayment_integration')
ON CONFLICT(version) DO NOTHING;
