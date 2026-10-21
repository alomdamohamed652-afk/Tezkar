ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS contract_value NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'production_orders_contract_value_nonnegative'
      AND conrelid = 'production_orders'::regclass
  ) THEN
    ALTER TABLE production_orders
      ADD CONSTRAINT production_orders_contract_value_nonnegative
      CHECK (contract_value >= 0);
  END IF;
END
$$;
