ALTER TABLE warehouse_receipt_lines
  ADD COLUMN IF NOT EXISTS cost_confirmed boolean NOT NULL DEFAULT TRUE;

ALTER TABLE inventory_lots
  ADD COLUMN IF NOT EXISTS cost_confirmed boolean NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS receipt_line_id uuid REFERENCES warehouse_receipt_lines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_movement_id uuid REFERENCES stock_movements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_pending_cost
  ON inventory_lots(product_id,warehouse_id,location_id,created_at,id)
  WHERE cost_confirmed=FALSE AND remaining_quantity>0;

CREATE INDEX IF NOT EXISTS idx_warehouse_receipt_lines_pending_cost
  ON warehouse_receipt_lines(receipt_id,id)
  WHERE cost_confirmed=FALSE;

INSERT INTO schema_migrations(version)
VALUES ('2026110402_receipt_cost_confirmation')
ON CONFLICT(version) DO NOTHING;
