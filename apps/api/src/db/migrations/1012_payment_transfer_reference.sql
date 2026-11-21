-- Store the transfer/account reference with the payout request and payment.
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS transfer_reference TEXT;
ALTER TABLE worker_payments
  ADD COLUMN IF NOT EXISTS transfer_reference TEXT;

INSERT INTO schema_migrations(version)
VALUES ('1012_payment_transfer_reference')
ON CONFLICT (version) DO NOTHING;
