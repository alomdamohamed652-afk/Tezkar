ALTER TABLE payroll_payments
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_payments_idempotency_key
  ON payroll_payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('2026102801_payroll_payment_idempotency')
ON CONFLICT(version) DO NOTHING;
