CREATE SEQUENCE IF NOT EXISTS rate_code_seq START 1;

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('ITM-' || lpad(nextval('product_code_seq')::TEXT, 6, '0')),
  name TEXT NOT NULL,
  description TEXT,
  product_type TEXT NOT NULL CHECK (product_type IN ('RAW_MATERIAL','COMPONENT','FINISHED_GOOD','SERVICE','CONSUMABLE')),
  category_id UUID REFERENCES product_categories(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  sku TEXT,
  barcode TEXT,
  color TEXT,
  thickness NUMERIC(12,3),
  size TEXT,
  minimum_stock NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  track_inventory BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('RATE-' || lpad(nextval('rate_code_seq')::TEXT, 6, '0')),
  product_id UUID REFERENCES products(id),
  stage_id UUID NOT NULL REFERENCES stages(id),
  rate_group_id UUID REFERENCES rate_groups(id),
  wage_type_id UUID NOT NULL REFERENCES wage_types(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  rate NUMERIC(18,4) NOT NULL CHECK (rate >= 0),
  effective_range DATERANGE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rates_effective_range_chk CHECK (NOT isempty(effective_range))
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rates_lookup ON rates(stage_id, rate_group_id, product_id, effective_range);
CREATE INDEX IF NOT EXISTS idx_rates_active ON rates(is_active, effective_range);

INSERT INTO schema_migrations(version) VALUES ('005_operations_master') ON CONFLICT (version) DO NOTHING;
