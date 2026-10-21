-- Link direct expenses to the exact production stage when the cost belongs to a stage.
-- Nullable so existing/general/order-level expenses remain unchanged.
ALTER TABLE accounting_expenses
  ADD COLUMN IF NOT EXISTS order_stage_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounting_expenses_order_stage_fk') THEN
    ALTER TABLE accounting_expenses
      ADD CONSTRAINT accounting_expenses_order_stage_fk
      FOREIGN KEY (order_stage_id) REFERENCES order_stages(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounting_expenses_order_stage
  ON accounting_expenses(order_stage_id) WHERE order_stage_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1021_accounting_expense_stage_link')
ON CONFLICT(version) DO NOTHING;
