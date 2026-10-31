-- Prevent duplicate manual advance receipts when a client retries a committed request.
ALTER TABLE advance_repayments
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_idempotency_key
  ON advance_repayments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='advance_repayments_idempotency_pair_check'
       AND conrelid='advance_repayments'::regclass
  ) THEN
    ALTER TABLE advance_repayments
      ADD CONSTRAINT advance_repayments_idempotency_pair_check
      CHECK (
        (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
        OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
      );
  END IF;
END $$;

INSERT INTO schema_migrations(version)
VALUES ('2026103102_advance_repayment_idempotency')
ON CONFLICT(version) DO NOTHING;
