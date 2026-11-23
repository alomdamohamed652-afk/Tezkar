-- Stage 5: receipts integrity — API-level idempotency for receipt submissions.
ALTER TABLE warehouse_receipts
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_receipts_idempotency_key_uidx
  ON warehouse_receipts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
