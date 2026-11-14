ALTER TABLE order_stages
  ADD COLUMN IF NOT EXISTS production_type_id UUID REFERENCES production_types(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_order_stages_production_type
  ON order_stages(production_type_id)
  WHERE production_type_id IS NOT NULL;
