-- Tezkar v0.4 operational model: orders, production types, costing, preferences and soft-deletion permissions

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS order_name TEXT,
  ADD COLUMN IF NOT EXISTS delivery_start_date DATE,
  ADD COLUMN IF NOT EXISTS last_delivery_date DATE;

UPDATE production_orders
SET order_name = COALESCE(NULLIF(order_name,''), code)
WHERE order_name IS NULL OR order_name='';

ALTER TABLE production_orders
  ADD CONSTRAINT production_orders_delivery_dates_chk
  CHECK (
    (delivery_start_date IS NULL OR delivery_start_date >= order_date)
    AND (last_delivery_date IS NULL OR last_delivery_date >= COALESCE(delivery_start_date, order_date))
  );

ALTER TABLE order_stages
  ADD COLUMN IF NOT EXISTS output_product_id UUID REFERENCES products(id),
  ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE INDEX IF NOT EXISTS idx_order_stages_output_product ON order_stages(output_product_id);

CREATE TABLE IF NOT EXISTS production_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  calculation_method TEXT NOT NULL DEFAULT 'PER_QUANTITY'
    CHECK (calculation_method IN ('PER_QUANTITY','PER_1000','PER_HOUR','PER_DAY','PERCENTAGE')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO production_types(code,name,calculation_method) VALUES
 ('PRINTING','طباعة','PER_1000'),
 ('PEELING','تقشير','PER_1000'),
 ('PACKING','تكييس','PER_1000'),
 ('PRESSING','كبس','PER_1000'),
 ('ASSEMBLY','تجميع','PER_QUANTITY'),
 ('CUTTING','قص','PER_QUANTITY'),
 ('UV_PRINTING','طباعة UV','PER_1000'),
 ('LASER','ليزر','PER_QUANTITY'),
 ('OTHER','أخرى','PER_QUANTITY')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE rates
  ADD COLUMN IF NOT EXISTS production_type_id UUID REFERENCES production_types(id);

CREATE INDEX IF NOT EXISTS idx_rates_production_type
  ON rates(stage_id,product_id,production_type_id,rate_group_id,is_active);

ALTER TABLE production_entries
  ADD COLUMN IF NOT EXISTS order_stage_id UUID REFERENCES order_stages(id),
  ADD COLUMN IF NOT EXISTS production_type_id UUID REFERENCES production_types(id);

CREATE INDEX IF NOT EXISTS idx_production_order_stage ON production_entries(order_stage_id);
CREATE INDEX IF NOT EXISTS idx_production_type ON production_entries(production_type_id);

ALTER TABLE machine_productions
  ADD COLUMN IF NOT EXISTS production_type_id UUID REFERENCES production_types(id);

CREATE INDEX IF NOT EXISTS idx_machine_production_type ON machine_productions(production_type_id);

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS warehouse_type TEXT NOT NULL DEFAULT 'GENERAL'
  CHECK (warehouse_type IN ('GENERAL','RAW_MATERIAL','WIP','FINISHED_GOODS','SCRAP'));

ALTER TABLE product_categories
  ADD COLUMN IF NOT EXISTS category_type TEXT NOT NULL DEFAULT 'PRODUCT'
  CHECK (category_type IN ('PRODUCT','RAW_MATERIAL','PRODUCTION_SUPPLY','OPERATING_SUPPLY'));

ALTER TABLE stock_balances
  ADD COLUMN IF NOT EXISTS avg_unit_cost NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK (avg_unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS inventory_value NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK (inventory_value >= 0);

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(24,8) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS total_cost NUMERIC(24,8) CHECK (total_cost IS NULL OR total_cost >= 0),
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES production_orders(id),
  ADD COLUMN IF NOT EXISTS order_stage_id UUID REFERENCES order_stages(id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_order ON stock_movements(order_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_cost ON stock_movements(created_at DESC,total_cost);

ALTER TABLE delivery_permissions
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES production_orders(id);

CREATE INDEX IF NOT EXISTS idx_delivery_permissions_order ON delivery_permissions(order_id,created_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preference_key TEXT NOT NULL,
  preference_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,preference_key)
);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('orders.dashboard','orders','order','dashboard','all'),
 ('orders.delete','orders','order','delete','all'),
 ('rates.view','production','rate','view','all'),
 ('rates.manage','production','rate','manage','all'),
 ('production_types.manage','production','production_type','manage','all'),
 ('warehouse.dashboard','warehouse','cost','dashboard','all'),
 ('employees.delete','hr','employee','delete','all'),
 ('users.delete','iam','user','delete','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager'
  AND p.code IN ('orders.dashboard','orders.delete','rates.view','rates.manage','production_types.manage','warehouse.dashboard','employees.delete','users.delete')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('production_manager','supervisor')
  AND p.code IN ('orders.dashboard','rates.view','rates.manage','production_types.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='warehouse_manager'
  AND p.code IN ('warehouse.dashboard')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('024_operational_model_v04')
ON CONFLICT (version) DO NOTHING;
