-- Preserve the originating worker payment when one settlement is split
-- across multiple order/stage expense rows.
ALTER TABLE accounting_expenses
  ADD COLUMN IF NOT EXISTS source_worker_payment_id UUID
    REFERENCES worker_payments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS accounting_expenses_source_worker_payment_idx
  ON accounting_expenses(source_worker_payment_id)
  WHERE source_worker_payment_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('2026111101_worker_payment_expense_source')
ON CONFLICT(version) DO NOTHING;
