CREATE SEQUENCE IF NOT EXISTS carton_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS delivery_permission_code_seq START 1;

CREATE TABLE IF NOT EXISTS cartons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CTN-' || lpad(nextval('carton_code_seq')::TEXT,8,'0')),
  barcode TEXT UNIQUE,
  product_id UUID NOT NULL REFERENCES products(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  location_id UUID NOT NULL REFERENCES warehouse_locations(id),
  quantity NUMERIC(24,6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_id UUID NOT NULL REFERENCES units(id),
  weight NUMERIC(24,6) CHECK (weight IS NULL OR weight >= 0),
  batch_code TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SEALED','PARTIAL','EMPTY')),
  sealed_at TIMESTAMPTZ,
  sealed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cartons_product_location ON cartons(product_id,warehouse_id,location_id);
CREATE INDEX IF NOT EXISTS idx_cartons_status ON cartons(status);

CREATE TABLE IF NOT EXISTS delivery_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('DEL-' || lpad(nextval('delivery_permission_code_seq')::TEXT,8,'0')),
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','RELEASED','CANCELLED')),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  released_by UUID REFERENCES users(id),
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_permission_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_permission_id UUID NOT NULL REFERENCES delivery_permissions(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  location_id UUID NOT NULL REFERENCES warehouse_locations(id),
  quantity NUMERIC(24,6) NOT NULL CHECK (quantity > 0),
  unit_id UUID NOT NULL REFERENCES units(id),
  carton_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_permissions_status ON delivery_permissions(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_lines_permission ON delivery_permission_lines(delivery_permission_id);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('cartons.view','warehouse','carton','view','all'),
 ('cartons.manage','warehouse','carton','manage','all'),
 ('deliveries.view','warehouse','delivery','view','all'),
 ('deliveries.create','warehouse','delivery','create','all'),
 ('deliveries.release','warehouse','delivery','release','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','warehouse_manager')
  AND p.code IN ('cartons.view','cartons.manage','deliveries.view','deliveries.create','deliveries.release')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='warehouse_staff'
  AND p.code IN ('cartons.view','cartons.manage','deliveries.view','deliveries.create')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('015_cartons_deliveries')
ON CONFLICT(version) DO NOTHING;
