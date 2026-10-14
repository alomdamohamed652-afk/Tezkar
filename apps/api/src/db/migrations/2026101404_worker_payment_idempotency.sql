ALTER TABLE worker_payments
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_worker_payments_idempotency_key
  ON worker_payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('2026101404_worker_payment_idempotency')
ON CONFLICT(version) DO NOTHING;
