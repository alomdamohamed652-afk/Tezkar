-- Allow multiple historical allocation cycles for the same worker payment and
-- production entry. Every cycle gets its own immutable allocation row; reversal
-- records remain attached to the exact row they reverse.
--
-- Resolve the generated UNIQUE constraint by its column definition instead of
-- relying on PostgreSQL's 63-byte truncated auto-generated constraint name.
--
-- This migration must not wait indefinitely behind active production transactions.
-- The runner retries short-lived lock contention and reports the exact migration.
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  allocation_constraint TEXT;
BEGIN
  SELECT c.conname
    INTO allocation_constraint
    FROM pg_constraint c
   WHERE c.conrelid = 'worker_payment_order_allocations'::regclass
     AND c.contype = 'u'
     AND (
       SELECT array_agg(a.attname ORDER BY key_column.ordinality)
         FROM unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid
          AND a.attnum = key_column.attnum
     ) = ARRAY['worker_payment_id', 'production_entry_id']::name[]
   LIMIT 1;

  IF allocation_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE worker_payment_order_allocations DROP CONSTRAINT %I',
      allocation_constraint
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS worker_payment_order_allocations_payment_production_idx
  ON worker_payment_order_allocations(worker_payment_id, production_entry_id);

-- A prior allocation event may be reversed and later re-created after explicit
-- accounting review. Keep the history, but no longer prohibit a later cycle.
DROP INDEX IF EXISTS worker_payment_settlement_difference_allocation_uq;

CREATE INDEX IF NOT EXISTS worker_payment_settlement_difference_allocation_history_idx
  ON worker_payment_settlement_difference_events(difference_id, production_entry_id, created_at)
  WHERE event_type='ALLOCATED_TO_PRODUCTION';

INSERT INTO schema_migrations(version)
VALUES ('2026111201_worker_difference_reallocation_cycles')
ON CONFLICT(version) DO NOTHING;
