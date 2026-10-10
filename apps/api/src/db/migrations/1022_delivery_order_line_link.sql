-- Preserve the exact order line through delivery reservation and stock-out movement.
ALTER TABLE delivery_permission_lines
  ADD COLUMN IF NOT EXISTS order_item_id UUID;
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS order_item_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='delivery_lines_order_item_fk') THEN
    ALTER TABLE delivery_permission_lines
      ADD CONSTRAINT delivery_lines_order_item_fk
      FOREIGN KEY (order_item_id) REFERENCES production_order_lines(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_order_item_fk') THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_order_item_fk
      FOREIGN KEY (order_item_id) REFERENCES production_order_lines(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Backfill only when product identity is unambiguous within the order.
WITH candidates AS (
  SELECT dl.id AS delivery_line_id, MIN(pol.id) AS order_item_id
    FROM delivery_permission_lines dl
    JOIN delivery_permissions dp ON dp.id=dl.delivery_permission_id
    JOIN production_order_lines pol ON pol.order_id=dp.order_id AND pol.product_id=dl.product_id
   WHERE dl.order_item_id IS NULL
   GROUP BY dl.id
  HAVING COUNT(pol.id)=1
)
UPDATE delivery_permission_lines dl
   SET order_item_id=c.order_item_id
  FROM candidates c
 WHERE dl.id=c.delivery_line_id;

-- Link historical delivery stock-outs only when a permission has one matching product line.
WITH candidates AS (
  SELECT sm.id AS movement_id, MIN(dl.order_item_id) AS order_item_id
    FROM stock_movements sm
    JOIN delivery_permission_lines dl ON dl.delivery_permission_id=sm.reference_id
                                      AND dl.product_id=sm.product_id
   WHERE sm.reference_type='DELIVERY'
     AND sm.order_item_id IS NULL
     AND dl.order_item_id IS NOT NULL
   GROUP BY sm.id
  HAVING COUNT(dl.id)=1
)
UPDATE stock_movements sm
   SET order_item_id=c.order_item_id
  FROM candidates c
 WHERE sm.id=c.movement_id;

CREATE INDEX IF NOT EXISTS idx_delivery_lines_order_item
  ON delivery_permission_lines(order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item
  ON stock_movements(order_item_id) WHERE order_item_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1022_delivery_order_line_link')
ON CONFLICT(version) DO NOTHING;
