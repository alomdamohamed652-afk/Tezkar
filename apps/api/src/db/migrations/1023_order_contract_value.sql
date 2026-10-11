ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS contract_value NUMERIC(14,2) NOT NULL DEFAULT 0;

ALTER TABLE production_orders
  ADD CONSTRAINT production_orders_contract_value_nonnegative
  CHECK (contract_value >= 0);
