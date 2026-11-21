-- @non-transactional-indexes
-- Build online to avoid blocking INSERT/UPDATE/DELETE for the duration of index creation.
-- The migration runner removes invalid remnants before retrying an interrupted build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS worker_payment_settlement_difference_events_production_idx
  ON worker_payment_settlement_difference_events(production_entry_id, event_type)
  WHERE production_entry_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS worker_payment_settlement_differences_employee_order_status_idx
  ON worker_payment_settlement_differences(employee_id, source_order_id, status);

INSERT INTO schema_migrations(version)
VALUES ('2026111401_report_payment_lookup_indexes')
ON CONFLICT(version) DO NOTHING;
