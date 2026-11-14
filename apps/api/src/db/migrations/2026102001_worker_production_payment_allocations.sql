ALTER TABLE employee_earnings_settlements
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES production_orders(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS employee_earnings_settlements_idempotency_key_uq
  ON employee_earnings_settlements(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS employee_earnings_settlements_order_employee_idx
  ON employee_earnings_settlements(order_id, employee_id, settlement_date);

CREATE TABLE IF NOT EXISTS employee_earnings_settlement_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id UUID NOT NULL REFERENCES employee_earnings_settlements(id) ON DELETE RESTRICT,
  production_entry_id UUID NOT NULL REFERENCES production_entries(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, production_entry_id)
);

CREATE INDEX IF NOT EXISTS employee_earnings_settlement_allocations_production_idx
  ON employee_earnings_settlement_allocations(production_entry_id);

CREATE TABLE IF NOT EXISTS worker_payment_order_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_payment_id UUID NOT NULL REFERENCES worker_payments(id) ON DELETE RESTRICT,
  production_entry_id UUID NOT NULL REFERENCES production_entries(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_payment_id, production_entry_id)
);

CREATE INDEX IF NOT EXISTS worker_payment_order_allocations_production_idx
  ON worker_payment_order_allocations(production_entry_id);
CREATE INDEX IF NOT EXISTS worker_payment_order_allocations_payment_idx
  ON worker_payment_order_allocations(worker_payment_id);
