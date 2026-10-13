-- Configure production-based advance installments without charging the loan at production approval.
ALTER TABLE advance_requests
  ADD COLUMN IF NOT EXISTS production_period_days INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS production_minimum_earning NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS production_installment_amount NUMERIC(14,2);

ALTER TABLE advance_requests
  DROP CONSTRAINT IF EXISTS advance_requests_production_period_days_check;
ALTER TABLE advance_requests
  ADD CONSTRAINT advance_requests_production_period_days_check
  CHECK (production_period_days BETWEEN 1 AND 90);

ALTER TABLE advance_requests
  DROP CONSTRAINT IF EXISTS advance_requests_production_minimum_earning_check;
ALTER TABLE advance_requests
  ADD CONSTRAINT advance_requests_production_minimum_earning_check
  CHECK (production_minimum_earning IS NULL OR production_minimum_earning >= 0);

ALTER TABLE advance_requests
  DROP CONSTRAINT IF EXISTS advance_requests_production_installment_amount_check;
ALTER TABLE advance_requests
  ADD CONSTRAINT advance_requests_production_installment_amount_check
  CHECK (production_installment_amount IS NULL OR production_installment_amount > 0);

-- A settlement represents gross approved earnings cleared, actual cash paid, and the
-- part applied to outstanding advances. Custody OUT(gross) + IN(repayment) nets to cash paid.
CREATE TABLE IF NOT EXISTS employee_earnings_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  gross_amount NUMERIC(14,2) NOT NULL CHECK (gross_amount > 0),
  cash_paid_amount NUMERIC(14,2) NOT NULL CHECK (cash_paid_amount >= 0),
  advance_repayment_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (advance_repayment_amount >= 0),
  settlement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ROUND(gross_amount,2) = ROUND(cash_paid_amount + advance_repayment_amount,2))
);

CREATE INDEX IF NOT EXISTS idx_employee_earnings_settlements_employee_date
  ON employee_earnings_settlements(employee_id,settlement_date DESC,created_at DESC);

ALTER TABLE advance_repayments
  ADD COLUMN IF NOT EXISTS settlement_id UUID REFERENCES employee_earnings_settlements(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_settlement_advance
  ON advance_repayments(settlement_id,advance_id)
  WHERE settlement_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1029_hr_advance_settlement_rules')
ON CONFLICT(version) DO NOTHING;
