CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SEQUENCE IF NOT EXISTS shift_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS rate_group_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS unit_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS category_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS product_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS stage_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS wage_type_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS rate_code_seq START 1;

CREATE TABLE IF NOT EXISTS rate_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('RGR-' || lpad(nextval('rate_group_code_seq')::TEXT,6,'0')),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('SFT-' || lpad(nextval('shift_code_seq')::TEXT,6,'0')),
  name TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  crosses_midnight BOOLEAN NOT NULL DEFAULT FALSE,
  rate_group_id UUID NOT NULL REFERENCES rate_groups(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_time <> end_time)
);

CREATE TABLE IF NOT EXISTS shift_leaders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES shifts(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  assignment_type TEXT NOT NULL DEFAULT 'primary',
  starts_on DATE,
  ends_on DATE,
  assigned_by UUID REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_shift_leaders_shift ON shift_leaders(shift_id,is_active);
CREATE INDEX IF NOT EXISTS idx_shift_leaders_employee ON shift_leaders(employee_id,is_active);

CREATE TABLE IF NOT EXISTS units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT,
  decimal_places SMALLINT NOT NULL DEFAULT 0 CHECK (decimal_places BETWEEN 0 AND 6),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unit_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_unit_id UUID NOT NULL REFERENCES units(id),
  to_unit_id UUID NOT NULL REFERENCES units(id),
  factor NUMERIC(24,8) NOT NULL CHECK (factor > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(from_unit_id,to_unit_id),
  CHECK (from_unit_id <> to_unit_id)
);

CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CAT-' || lpad(nextval('category_code_seq')::TEXT,6,'0')),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('ITM-' || lpad(nextval('product_code_seq')::TEXT,6,'0')),
  name TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES product_categories(id),
  product_type TEXT NOT NULL CHECK (product_type IN ('RAW_MATERIAL','COMPONENT','FINISHED_GOOD','SERVICE','CONSUMABLE')),
  unit_id UUID NOT NULL REFERENCES units(id),
  sku TEXT,
  barcode TEXT,
  color TEXT,
  thickness NUMERIC(18,6),
  size TEXT,
  minimum_stock NUMERIC(24,6) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  track_inventory BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku ON products(sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);

CREATE TABLE IF NOT EXISTS stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('STG-' || lpad(nextval('stage_code_seq')::TEXT,6,'0')),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wage_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('WGT-' || lpad(nextval('wage_type_code_seq')::TEXT,6,'0')),
  name TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('PER_PIECE','PER_1000','PER_HOUR','PER_DAY','PERCENTAGE')),
  percentage_base TEXT CHECK (percentage_base IS NULL OR percentage_base IN ('ORDER_VALUE','LINE_VALUE','CUSTOM_BASE')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('RATE-' || lpad(nextval('rate_code_seq')::TEXT,6,'0')),
  product_id UUID REFERENCES products(id),
  stage_id UUID NOT NULL REFERENCES stages(id),
  rate_group_id UUID NOT NULL REFERENCES rate_groups(id),
  wage_type_id UUID NOT NULL REFERENCES wage_types(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  rate NUMERIC(24,8) NOT NULL CHECK (rate >= 0),
  effective_range DATERANGE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT isempty(effective_range))
);

CREATE INDEX IF NOT EXISTS idx_rates_lookup ON rates(product_id,stage_id,rate_group_id,is_active);
CREATE INDEX IF NOT EXISTS idx_rates_effective ON rates USING GIST(effective_range);

CREATE TABLE IF NOT EXISTS rate_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_id UUID REFERENCES rates(id),
  policy TEXT NOT NULL CHECK (policy IN ('NEW_PRODUCTION_ONLY','UNPAID_RETROACTIVE','UNPAID_AND_FUTURE')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','APPLIED','REJECTED','CANCELLED')),
  created_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);

INSERT INTO units(code,name,symbol,decimal_places) VALUES
 ('PCS','قطعة','pcs',0),('KG','كيلوجرام','kg',3),('G','جرام','g',3),
 ('M','متر','m',3),('CM','سنتيمتر','cm',2),('L','لتر','l',3),
 ('ML','ملليلتر','ml',3),('BOX','كرتونة','box',0),('PACK','عبوة','pack',0),
 ('HOUR','ساعة','hr',2)
ON CONFLICT(code) DO NOTHING;

INSERT INTO wage_types(code,name,method,percentage_base) VALUES
 ('PER_PIECE','بالقطعة','PER_PIECE',NULL),
 ('PER_1000','لكل 1000','PER_1000',NULL),
 ('PER_HOUR','بالساعة','PER_HOUR',NULL),
 ('PER_DAY','باليومية','PER_DAY',NULL),
 ('PERCENTAGE_ORDER','نسبة من قيمة الطلب','PERCENTAGE','ORDER_VALUE'),
 ('PERCENTAGE_LINE','نسبة من قيمة السطر','PERCENTAGE','LINE_VALUE')
ON CONFLICT(code) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('006_shifts_rates_products')
ON CONFLICT(version) DO NOTHING;
