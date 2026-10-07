CREATE SEQUENCE IF NOT EXISTS order_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS machine_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS machine_production_code_seq START 1;

CREATE TABLE IF NOT EXISTS production_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('ORD-' || lpad(nextval('order_code_seq')::TEXT, 8, '0')),
  customer_name TEXT,
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PLANNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (due_date IS NULL OR due_date >= order_date)
);

CREATE TABLE IF NOT EXISTS production_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity NUMERIC(24,6) NOT NULL CHECK (quantity > 0),
  unit_id UUID NOT NULL REFERENCES units(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  stage_id UUID NOT NULL REFERENCES stages(id),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','READY','IN_PROGRESS','COMPLETED','CANCELLED')),
  planned_quantity NUMERIC(24,6),
  completed_quantity NUMERIC(24,6) NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(order_id, sequence_no),
  UNIQUE(order_id, stage_id)
);

CREATE TABLE IF NOT EXISTS stage_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id UUID NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(stage_id, product_id)
);

CREATE TABLE IF NOT EXISTS machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('MCH-' || lpad(nextval('machine_code_seq')::TEXT, 5, '0')),
  name TEXT NOT NULL,
  machine_type TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machine_productions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('MPR-' || lpad(nextval('machine_production_code_seq')::TEXT, 8, '0')),
  order_stage_id UUID REFERENCES order_stages(id),
  machine_id UUID NOT NULL REFERENCES machines(id),
  product_id UUID NOT NULL REFERENCES products(id),
  employee_id UUID REFERENCES employees(id),
  shift_id UUID REFERENCES shifts(id),
  work_date DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity NUMERIC(24,6) NOT NULL CHECK (quantity > 0),
  unit_id UUID NOT NULL REFERENCES units(id),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status_date ON production_orders(status, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON production_order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_order_stages_order ON order_stages(order_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_stage_outputs_stage ON stage_outputs(stage_id);
CREATE INDEX IF NOT EXISTS idx_machines_active ON machines(is_active);
CREATE INDEX IF NOT EXISTS idx_machine_production_date ON machine_productions(work_date DESC, machine_id);
CREATE INDEX IF NOT EXISTS idx_machine_production_order_stage ON machine_productions(order_stage_id);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
('orders.view','orders','order','view','all'),
('orders.create','orders','order','create','all'),
('orders.edit','orders','order','edit','all'),
('orders.manage_stages','orders','order_stage','manage','all'),
('machines.view','production','machine','view','all'),
('machines.create','production','machine','create','all'),
('machines.edit','production','machine','edit','all'),
('machine_production.view','production','machine_production','view','all'),
('machine_production.create','production','machine_production','create','all'),
('production.view_own','production','production','view','own'),
('earnings.view_own','earnings','ledger','view','own'),
('account.change_password','iam','account','change_password','own')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager'
  AND p.code IN ('orders.view','orders.create','orders.edit','orders.manage_stages','machines.view','machines.create','machines.edit','machine_production.view','machine_production.create','production.view_own','earnings.view_own','account.change_password')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('production_manager','supervisor')
  AND p.code IN ('orders.view','orders.create','orders.edit','orders.manage_stages','machines.view','machines.create','machines.edit','machine_production.view','machine_production.create')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='worker'
  AND p.code IN ('production.view_own','earnings.view_own','account.change_password')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='hr'
  AND p.code='account.change_password'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('022_orders_machines_rbac')
ON CONFLICT (version) DO NOTHING;
