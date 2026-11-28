-- Add a dedicated, inventory-tracked scrap product for each source product.
-- Existing products and stock balances are preserved.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS scrap_source_product_id UUID REFERENCES products(id);

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'products'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%product_type%'
  LOOP
    EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;

  ALTER TABLE products
    ADD CONSTRAINT products_product_type_check
    CHECK (product_type IN ('RAW_MATERIAL','COMPONENT','FINISHED_GOOD','SERVICE','CONSUMABLE','SCRAP'));
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_scrap_source_product
  ON products(scrap_source_product_id)
  WHERE product_type = 'SCRAP' AND scrap_source_product_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('2026101501_scrap_products_by_source_product')
ON CONFLICT (version) DO NOTHING;
