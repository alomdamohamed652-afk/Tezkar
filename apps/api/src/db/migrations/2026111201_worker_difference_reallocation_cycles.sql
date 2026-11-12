-- Allow multiple historical allocation cycles for the same worker payment and
-- production entry. Every cycle gets its own immutable allocation row; reversal
-- records remain attached to the exact row they reverse.
ALTER TABLE worker_payment_order_allocations
  DROP CONSTRAINT IF EXISTS worker_payment_order_allocations_worker_payment_id_production_entry_id_key;

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
