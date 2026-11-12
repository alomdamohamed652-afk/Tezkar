-- Persist the custody source as structured payment data rather than inferring it from notes.
ALTER TABLE worker_payments
  ADD COLUMN IF NOT EXISTS settlement_source TEXT;

-- Backfill historical previous-custody payments from their original settlement marker.
UPDATE worker_payments wp
   SET settlement_source = CASE
     WHEN EXISTS (
       SELECT 1
         FROM employee_earnings_settlements es
        WHERE es.worker_payment_id = wp.id
          AND COALESCE(es.notes, '') LIKE '%تسوية من عهدة سابقة%'
     ) THEN 'PREVIOUS_CUSTODY'
     ELSE 'CURRENT_CUSTODY'
   END
 WHERE settlement_source IS NULL;

ALTER TABLE worker_payments
  ALTER COLUMN settlement_source SET DEFAULT 'CURRENT_CUSTODY';

ALTER TABLE worker_payments
  ALTER COLUMN settlement_source SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'worker_payments'::regclass
       AND conname = 'worker_payments_settlement_source_check'
  ) THEN
    ALTER TABLE worker_payments
      ADD CONSTRAINT worker_payments_settlement_source_check
      CHECK (settlement_source IN ('CURRENT_CUSTODY', 'PREVIOUS_CUSTODY'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS worker_payments_settlement_source_idx
  ON worker_payments(settlement_source, created_at);

INSERT INTO schema_migrations(version)
VALUES ('2026111202_worker_payment_settlement_source')
ON CONFLICT(version) DO NOTHING;
