ALTER TABLE production_entries
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id),
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES warehouse_locations(id);

CREATE INDEX IF NOT EXISTS idx_production_inventory_destination
  ON production_entries(warehouse_id, location_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movement_production_reference
  ON stock_movements(reference_id)
  WHERE reference_type='PRODUCTION' AND reference_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('021_production_inventory_link')
ON CONFLICT (version) DO NOTHING;
