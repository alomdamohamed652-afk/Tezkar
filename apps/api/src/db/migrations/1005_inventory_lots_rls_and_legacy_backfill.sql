ALTER TABLE inventory_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_withdrawal_lines ENABLE ROW LEVEL SECURITY;

INSERT INTO inventory_lots(product_id,warehouse_id,location_id,batch_code,unit_cost,original_quantity,remaining_quantity,source_type,source_id)
SELECT b.product_id,b.warehouse_id,b.location_id,'LEGACY-'||b.product_id::text,b.avg_unit_cost,b.quantity,b.quantity,'LEGACY_STOCK',NULL
FROM stock_balances b
WHERE b.quantity>0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_lots l
    WHERE l.product_id=b.product_id AND l.warehouse_id=b.warehouse_id AND l.location_id=b.location_id
      AND l.source_type='LEGACY_STOCK'
  );

INSERT INTO schema_migrations(version) VALUES ('1005_inventory_lots_rls_and_legacy_backfill')
ON CONFLICT(version) DO NOTHING;