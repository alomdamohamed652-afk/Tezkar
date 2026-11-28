-- Prevent ordinary UPDATE/DELETE statements from mutating saved close evidence.
-- Use standalone SQL rules because the migration runner splits statements on semicolons.
DROP RULE IF EXISTS accounting_period_close_snapshots_no_update ON accounting_period_close_snapshots;
CREATE RULE accounting_period_close_snapshots_no_update AS
  ON UPDATE TO accounting_period_close_snapshots DO INSTEAD NOTHING;
DROP RULE IF EXISTS accounting_period_close_snapshots_no_delete ON accounting_period_close_snapshots;
CREATE RULE accounting_period_close_snapshots_no_delete AS
  ON DELETE TO accounting_period_close_snapshots DO INSTEAD NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026101702_accounting_period_snapshot_immutability')
ON CONFLICT(version) DO NOTHING;
