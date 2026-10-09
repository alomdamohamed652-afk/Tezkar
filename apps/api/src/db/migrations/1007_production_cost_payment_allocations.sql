-- Production total labor cost and exact worker-payment allocation

ALTER TABLE production_entries
  ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  ADD COLUMN IF NOT EXISTS deduction_amount NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (deduction_amount >= 0);

ALTER TABLE production_entries
  ADD COLUMN IF NOT EXISTS total_earning_amount NUMERIC(18,4)
  GENERATED ALWAYS AS (earning_amount + bonus_amount - deduction_amount) STORED;

CREATE TABLE IF NOT EXISTS worker_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_payment_id UUID NOT NULL REFERENCES worker_payments(id) ON DELETE CASCADE,
  production_entry_id UUID NOT NULL REFERENCES production_entries(id),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(worker_payment_id,production_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_payment_allocations_production
  ON worker_payment_allocations(production_entry_id,created_at);

CREATE INDEX IF NOT EXISTS idx_worker_payment_allocations_payment
  ON worker_payment_allocations(worker_payment_id);

INSERT INTO schema_migrations(version)
VALUES ('1007_production_cost_payment_allocations')
ON CONFLICT(version) DO NOTHING;
