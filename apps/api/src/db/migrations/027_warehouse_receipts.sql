-- Tezkar v0.7: warehouse receipt documents
CREATE SEQUENCE IF NOT EXISTS warehouse_receipt_code_seq START 1;

CREATE TABLE IF NOT EXISTS warehouse_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('REC-' || lpad(nextval('warehouse_receipt_code_seq')::TEXT,8,'0')),
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT NOT NULL,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouse_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  location_id UUID NOT NULL REFERENCES warehouse_locations(id),
  quantity NUMERIC(24,6) NOT NULL CHECK (quantity > 0),
  unit_id UUID NOT NULL REFERENCES units(id),
  unit_cost NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  batch_code TEXT,
  weight NUMERIC(24,6),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_warehouse_receipts_date ON warehouse_receipts(receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_receipt_lines_receipt ON warehouse_receipt_lines(receipt_id);

INSERT INTO schema_migrations(version) VALUES ('027_warehouse_receipts')
ON CONFLICT(version) DO NOTHING;
