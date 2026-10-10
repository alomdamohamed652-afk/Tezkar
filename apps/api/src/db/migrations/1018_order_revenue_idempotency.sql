-- Add a stable operation key so retried customer-collection requests cannot
-- create a second revenue/custody pair. NULL remains valid for legacy/manual rows.
ALTER TABLE order_revenues
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS order_revenues_idempotency_key_uidx
  ON order_revenues (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
