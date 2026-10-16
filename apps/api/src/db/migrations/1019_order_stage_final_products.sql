-- Allow each stage output to be independently designated as a deliverable product.
-- Existing order lines and historical stage records are preserved.
ALTER TABLE order_stages
  ADD COLUMN IF NOT EXISTS is_final_product BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill legacy single-final-product orders where the final stage output matches
-- a product already recorded on the order.
UPDATE order_stages os
   SET is_final_product = TRUE
 WHERE os.output_product_id IS NOT NULL
   AND os.sequence_no = (
     SELECT MAX(os2.sequence_no)
       FROM order_stages os2
      WHERE os2.order_id = os.order_id
   )
   AND EXISTS (
     SELECT 1
       FROM production_order_lines pol
      WHERE pol.order_id = os.order_id
        AND pol.product_id = os.output_product_id
   );
