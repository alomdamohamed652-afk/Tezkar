ALTER TABLE order_stages
  ADD COLUMN IF NOT EXISTS is_final_output BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve the prior behavior for existing orders: only a last-stage output
-- matching an ordered product is backfilled as a final delivery product.
UPDATE order_stages os
   SET is_final_output=TRUE
 WHERE os.is_final_output=FALSE
   AND os.status <> 'CANCELLED'
   AND os.output_product_id IS NOT NULL
   AND os.sequence_no=(
     SELECT MAX(last_stage.sequence_no)
       FROM order_stages last_stage
      WHERE last_stage.order_id=os.order_id
        AND last_stage.status <> 'CANCELLED'
   )
   AND EXISTS(
     SELECT 1
       FROM production_order_lines pol
      WHERE pol.order_id=os.order_id
        AND pol.product_id=os.output_product_id
   );
