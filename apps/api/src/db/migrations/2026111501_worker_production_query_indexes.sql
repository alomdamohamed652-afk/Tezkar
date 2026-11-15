-- Target the hot worker-production screens: bounded date history, worker settlement
-- lookups, and the filters used most often by production history.
-- Keep lock waits bounded because the migration runner applies each migration atomically.
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_production_active_work_date_created
  ON production_entries(work_date DESC, created_at DESC)
  WHERE status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS idx_production_employee_status_date
  ON production_entries(employee_id, status, work_date DESC);

CREATE INDEX IF NOT EXISTS idx_production_order_stage_date
  ON production_entries(order_stage_id, work_date DESC)
  WHERE status <> 'CANCELLED' AND order_stage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_production_stage_date
  ON production_entries(stage_id, work_date DESC)
  WHERE status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS idx_production_shift_date
  ON production_entries(shift_id, work_date DESC)
  WHERE status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS idx_production_type_date
  ON production_entries(production_type_id, work_date DESC)
  WHERE status <> 'CANCELLED' AND production_type_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS employee_earnings_settlements_employee_date_idx
  ON employee_earnings_settlements(employee_id, settlement_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS employee_earnings_settlement_allocations_settlement_idx
  ON employee_earnings_settlement_allocations(settlement_id, production_entry_id);

INSERT INTO schema_migrations(version)
VALUES ('2026111501_worker_production_query_indexes')
ON CONFLICT (version) DO NOTHING;
