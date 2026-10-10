-- Link each order stage to the exact finished-product line it produces.
-- Nullable for historical/non-final stages; new final stages are linked by the API.
ALTER TABLE production_order_lines
  ADD CONSTRAINT production_order_lines_order_id_id_uq UNIQUE (order_id, id);

ALTER TABLE order_stages
  ADD COLUMN IF NOT EXISTS order_item_id UUID;

-- Best-effort legacy backfill: match final stages and order lines by product within
-- each order, using stable sequence/creation ordering. Unmatched legacy rows remain NULL.
WITH ranked_stages AS (
  SELECT os.id, os.order_id, os.output_product_id,
         ROW_NUMBER() OVER (
           PARTITION BY os.order_id, os.output_product_id
           ORDER BY os.sequence_no, os.id
         ) AS rn
    FROM order_stages os
   WHERE os.is_final_product = TRUE
     AND os.output_product_id IS NOT NULL
),
ranked_lines AS (
  SELECT pol.id, pol.order_id, pol.product_id,
         ROW_NUMBER() OVER (
           PARTITION BY pol.order_id, pol.product_id
           ORDER BY pol.created_at, pol.id
         ) AS rn
    FROM production_order_lines pol
)
UPDATE order_stages os
   SET order_item_id = rl.id
  FROM ranked_stages rs
  JOIN ranked_lines rl
    ON rl.order_id = rs.order_id
   AND rl.product_id = rs.output_product_id
   AND rl.rn = rs.rn
 WHERE os.id = rs.id
   AND os.order_item_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_stages_order_item_order_fk'
  ) THEN
    ALTER TABLE order_stages
      ADD CONSTRAINT order_stages_order_item_order_fk
      FOREIGN KEY (order_id, order_item_id)
      REFERENCES production_order_lines(order_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_stages_order_item
  ON order_stages(order_item_id);

INSERT INTO schema_migrations(version)
VALUES ('1020_order_stage_final_line_link')
ON CONFLICT(version) DO NOTHING;
