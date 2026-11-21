CREATE TABLE IF NOT EXISTS production_scrap_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_entry_id UUID NOT NULL REFERENCES production_entries(id) ON DELETE RESTRICT,
  scrap_type TEXT NOT NULL CHECK (scrap_type IN ('WORKER_SCRAP','MANUFACTURING_DEFECT')),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  notes TEXT,
  recorded_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_production_scrap_entry ON production_scrap_records(production_entry_id);
CREATE INDEX IF NOT EXISTS idx_production_scrap_type_date ON production_scrap_records(scrap_type, created_at DESC);
