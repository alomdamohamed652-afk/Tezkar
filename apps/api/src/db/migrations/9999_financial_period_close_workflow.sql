-- Quarterly accounting close review, approval, and auditable carry-forward balances.
ALTER TABLE accounting_periods
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closing_snapshot jsonb;

CREATE TABLE IF NOT EXISTS accounting_period_rollovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  target_period_id uuid REFERENCES accounting_periods(id),
  balance_type text NOT NULL CHECK (balance_type IN ('CASH_CUSTODY','WORKER_EARNINGS','ADVANCE','INVENTORY')),
  reference_id uuid NOT NULL,
  label text NOT NULL,
  amount numeric(14,2) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_period_id, balance_type, reference_id)
);
CREATE INDEX IF NOT EXISTS accounting_period_rollovers_target_idx
  ON accounting_period_rollovers(target_period_id, balance_type);
