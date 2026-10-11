-- Make order expenses posted from employee cash custody safe to retry.
-- The operation key is separate from amount/date so legitimate identical purchases remain allowed.
ALTER TABLE accounting_expenses
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_expenses_idempotency_key_uidx
  ON accounting_expenses (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
