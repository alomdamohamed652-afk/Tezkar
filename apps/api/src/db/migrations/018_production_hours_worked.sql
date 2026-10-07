ALTER TABLE production_entries
  ADD COLUMN IF NOT EXISTS hours_worked NUMERIC(10,2);

ALTER TABLE production_entries
  ADD CONSTRAINT production_hours_worked_chk
  CHECK (hours_worked IS NULL OR hours_worked > 0);

INSERT INTO schema_migrations(version)
VALUES ('018_production_hours_worked')
ON CONFLICT (version) DO NOTHING;
