-- Order-stage pricing has its own immutable rate snapshot and need not reference
-- a reusable general-purpose rates row. Keep historical snapshots unchanged while
-- allowing production entries priced directly by their associated order stage.
ALTER TABLE production_entries ALTER COLUMN rate_id DROP NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1013_allow_stage_priced_production')
ON CONFLICT (version) DO NOTHING;
