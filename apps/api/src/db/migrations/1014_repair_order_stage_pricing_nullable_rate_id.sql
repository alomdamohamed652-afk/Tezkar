-- Repair deployments where order-stage pricing still encounters the historical
-- NOT NULL constraint on production_entries.rate_id. Stage pricing is stored as a
-- snapshot and may not have a matching global rates row. This is idempotent and
-- keeps the existing FK enforced whenever rate_id is non-null.
ALTER TABLE production_entries
  ALTER COLUMN rate_id DROP NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1014_repair_order_stage_pricing_nullable_rate_id')
ON CONFLICT (version) DO NOTHING;
