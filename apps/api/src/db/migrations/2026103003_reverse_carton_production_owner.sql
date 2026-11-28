ALTER TABLE reverse_code_carton_records
  ADD COLUMN IF NOT EXISTS production_employee_id UUID NULL
    REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reverse_carton_records_production_employee
  ON reverse_code_carton_records(production_employee_id);
