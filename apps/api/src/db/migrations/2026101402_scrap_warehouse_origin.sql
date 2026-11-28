ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS scrap_origin_type TEXT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS scrap_origin_reference TEXT;
CREATE INDEX IF NOT EXISTS idx_stock_movements_scrap_origin ON stock_movements(scrap_origin_type,created_at DESC) WHERE scrap_origin_type IS NOT NULL;
