-- Stable operation key and payload fingerprint prevent retries from duplicating
-- customer revenue/custody while still allowing independent identical collections.
ALTER TABLE order_revenues
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS order_revenues_idempotency_key_uidx
  ON order_revenues (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
