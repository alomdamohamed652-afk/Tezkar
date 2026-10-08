ALTER TABLE coding_units
  ADD COLUMN IF NOT EXISTS production_entry_id UUID REFERENCES production_entries(id);

CREATE INDEX IF NOT EXISTS idx_coding_units_production_entry
  ON coding_units(production_entry_id,created_at);

INSERT INTO schema_migrations(version)
VALUES ('1008_coding_production_links')
ON CONFLICT(version) DO NOTHING;
