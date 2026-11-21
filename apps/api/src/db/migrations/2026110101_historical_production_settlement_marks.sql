-- Administrative evidence that legacy production earnings were paid outside TEZKAR.
-- This table is intentionally separate from all financial ledgers and cash movements.
CREATE TABLE IF NOT EXISTS historical_production_settlement_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  production_entry_id UUID NOT NULL UNIQUE REFERENCES production_entries(id) ON DELETE RESTRICT,
  amount_snapshot NUMERIC(18,4) NOT NULL CHECK (amount_snapshot > 0),
  status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW'
    CHECK (status IN ('PAID_PREVIOUSLY','NEEDS_REVIEW')),
  payment_date DATE,
  notes TEXT,
  marked_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'PAID_PREVIOUSLY' OR length(trim(COALESCE(notes,''))) >= 2)
);

CREATE INDEX IF NOT EXISTS historical_production_settlement_marks_employee_status_idx
  ON historical_production_settlement_marks(employee_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS historical_production_settlement_marks_paid_idx
  ON historical_production_settlement_marks(production_entry_id)
  WHERE status='PAID_PREVIOUSLY';

INSERT INTO schema_migrations(version)
VALUES ('2026110101_historical_production_settlement_marks')
ON CONFLICT(version) DO NOTHING;
