-- Order-stage prices are snapshotted directly from order_stages and do not
-- necessarily have a matching global rates row. Keep rate_id optional for
-- those entries while preserving the FK for entries that reference a rates row.
ALTER TABLE production_entries
  ALTER COLUMN rate_id DROP NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1013_order_stage_pricing_nullable_rate_id')
ON CONFLICT(version) DO NOTHING;
