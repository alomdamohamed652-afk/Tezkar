-- A worker payment can be fully settled through advance offsets with no physical cash paid.
-- Keep the gross settlement positive; allow the net cash component to be zero.
ALTER TABLE worker_payments
  DROP CONSTRAINT IF EXISTS worker_payments_amount_check;

ALTER TABLE worker_payments
  ADD CONSTRAINT worker_payments_amount_check CHECK (amount >= 0);

INSERT INTO schema_migrations(version)
VALUES ('2026111102_worker_payment_zero_cash')
ON CONFLICT(version) DO NOTHING;
