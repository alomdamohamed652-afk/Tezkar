ALTER TABLE production_scrap_records
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_production_scrap_idempotency_key
  ON production_scrap_records(idempotency_key);
