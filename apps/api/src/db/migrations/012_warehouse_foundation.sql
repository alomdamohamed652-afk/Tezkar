CREATE SEQUENCE IF NOT EXISTS warehouse_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS warehouse_location_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS stock_movement_code_seq START 1;

CREATE TABLE IF NOT EXISTS warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('WH-' || lpad(nextval('warehouse_code_seq')::TEXT,6,'0')),
  name TEXT NOT NULL,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouse_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS stock_balances (
  product_id UUID NOT NULL REFERENCES products(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  location_id UUID REFERENCES warehouse_locations(id),
  quantity NUMERIC(24,6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(product_id, warehouse_id, location_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('STK-' || lpad(nextval('stock_movement_code_seq')::TEXT,8,'0')),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('IN','OUT','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT','RETURN')),
  product_id UUID NOT NULL REFERENCES products(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  location_id UUID REFERENCES warehouse_locations(id),
  quantity NUMERIC(24,6) NOT NULL CHECK (quantity > 0),
  unit_id UUID NOT NULL REFERENCES units(id),
  reference_type TEXT,
  reference_id UUID,
  carton_code TEXT,
  batch_code TEXT,
  weight NUMERIC(24,6) CHECK (weight IS NULL OR weight >= 0),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_balances_warehouse ON stock_balances(warehouse_id, product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_carton ON stock_movements(carton_code) WHERE carton_code IS NOT NULL;

INSERT INTO roles(code,name,is_system) VALUES
 ('warehouse_manager','مسؤول المخزن',TRUE),
 ('warehouse_staff','موظف مخزن',TRUE)
ON CONFLICT(code) DO NOTHING;

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('warehouse.view','warehouse','stock','view','all'),
 ('warehouse.move','warehouse','stock','move','all'),
 ('warehouse.manage','warehouse','warehouse','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager' AND p.code IN ('warehouse.view','warehouse.move','warehouse.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='warehouse_manager' AND p.code IN ('warehouse.view','warehouse.move','warehouse.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='warehouse_staff' AND p.code IN ('warehouse.view','warehouse.move')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('012_warehouse_foundation')
ON CONFLICT(version) DO NOTHING;
