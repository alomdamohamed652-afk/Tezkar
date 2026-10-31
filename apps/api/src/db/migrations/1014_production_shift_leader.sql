ALTER TABLE production_entries
  ADD COLUMN IF NOT EXISTS shift_leader_employee_id UUID REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_production_entries_shift_leader
  ON production_entries(shift_leader_employee_id) WHERE shift_leader_employee_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1014_production_shift_leader')
ON CONFLICT(version) DO NOTHING;
