-- Extend the existing finance reversal journal for single worker-settlement difference events.
-- A reversed event is held for accounting review until an authorized user explicitly releases it.
ALTER TABLE worker_payment_settlement_differences
  DROP CONSTRAINT IF EXISTS worker_payment_settlement_differences_status_check;

ALTER TABLE worker_payment_settlement_differences
  ADD CONSTRAINT worker_payment_settlement_differences_status_check
  CHECK (status IN (
    'PENDING','PARTIALLY_ALLOCATED','ALLOCATED',
    'TRANSFERRED_TO_SOURCE_ORDER','REQUIRES_REVIEW','REVERSED'
  ));

ALTER TABLE worker_payment_settlement_difference_events
  DROP CONSTRAINT IF EXISTS worker_payment_settlement_difference_events_event_type_check;

ALTER TABLE worker_payment_settlement_difference_events
  ADD CONSTRAINT worker_payment_settlement_difference_events_event_type_check
  CHECK (event_type IN (
    'ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER',
    'REVERSED','RELEASED_AFTER_REVIEW'
  ));

ALTER TABLE worker_payment_settlement_difference_events
  DROP CONSTRAINT IF EXISTS worker_payment_settlement_difference_events_check;

ALTER TABLE worker_payment_settlement_difference_events
  DROP CONSTRAINT IF EXISTS worker_payment_settlement_difference_events_check1;

ALTER TABLE worker_payment_settlement_difference_events
  ADD CONSTRAINT worker_payment_settlement_difference_events_shape_check
  CHECK (
    (
      (actor_type='USER' AND actor_user_id IS NOT NULL)
      OR (actor_type='SYSTEM' AND actor_user_id IS NULL)
    )
    AND (
    (event_type='ALLOCATED_TO_PRODUCTION'
      AND production_entry_id IS NOT NULL
      AND worker_payment_order_allocation_id IS NOT NULL
      AND reverses_event_id IS NULL
      AND financial_reversal_id IS NULL)
    OR
    (event_type='TRANSFERRED_TO_SOURCE_ORDER'
      AND production_entry_id IS NULL
      AND worker_payment_order_allocation_id IS NULL
      AND target_order_id=source_order_id
      AND reverses_event_id IS NULL
      AND financial_reversal_id IS NULL)
    OR
    (event_type='REVERSED'
      AND reverses_event_id IS NOT NULL
      AND financial_reversal_id IS NOT NULL)
    OR
    (event_type='RELEASED_AFTER_REVIEW'
      AND production_entry_id IS NULL
      AND worker_payment_order_allocation_id IS NULL
      AND target_order_id=source_order_id
      AND reverses_event_id IS NULL
      AND financial_reversal_id IS NULL)
  );

ALTER TABLE financial_reversal_lines
  DROP CONSTRAINT IF EXISTS financial_reversal_lines_source_type_check;

ALTER TABLE financial_reversal_lines
  ADD CONSTRAINT financial_reversal_lines_source_type_check
  CHECK (source_type IN (
    'PAYROLL_PAYMENT','ADVANCE_REPAYMENT','ZERO_NET_PAYROLL_SETTLEMENT',
    'WORKER_PAYMENT','WORKER_SETTLEMENT_DIFFERENCE_EVENT'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS financial_reversal_lines_worker_difference_event_uq
  ON financial_reversal_lines(source_id)
  WHERE source_type='WORKER_SETTLEMENT_DIFFERENCE_EVENT';

-- A reviewed reversal may be released and matured again; the event ledger is the
-- source of truth, so multiple historical transfers are allowed and remain reversible.
DROP INDEX IF EXISTS worker_payment_settlement_difference_transfer_uq;

CREATE INDEX IF NOT EXISTS worker_payment_settlement_difference_review_idx
  ON worker_payment_settlement_differences(status, updated_at)
  WHERE status='REQUIRES_REVIEW';

INSERT INTO schema_migrations(version)
VALUES ('2026111106_worker_difference_event_reversal_review')
ON CONFLICT(version) DO NOTHING;
