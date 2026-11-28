ALTER TABLE production_entries ADD COLUMN IF NOT EXISTS responsible_name TEXT;

INSERT INTO schema_migrations(version) VALUES ('1012_production_responsible_name') ON CONFLICT (version) DO NOTHING;
