ALTER TABLE advance_repayments
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_idempotency_key
  ON advance_repayments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('2026110501_advance_repayment_idempotency')
ON CONFLICT(version) DO NOTHING;
