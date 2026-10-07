-- Tezkar v0.6: warehouse receiving/transfers, employee custody, administrative advances repayment, product de-duplication guard

-- Product names are business-facing master data. Prevent concurrent duplicate active names.
-- Existing duplicates are intentionally left untouched; the API resolves to the oldest active record.
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_active_normalized_name
  ON products ((lower(btrim(name))))
  WHERE is_active=TRUE;

CREATE SEQUENCE IF NOT EXISTS custody_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS custody_settlement_code_seq START 1;
CREATE TABLE IF NOT EXISTS employee_custodies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CUS-' || lpad(nextval('custody_code_seq')::TEXT,8,'0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  custody_type TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_value NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (unit_value >= 0),
  total_value NUMERIC(18,4) NOT NULL CHECK (total_value >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PARTIAL_RETURNED','RETURNED','DAMAGED','LOST','CANCELLED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date DATE,
  returned_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_custodies_employee_status
  ON employee_custodies(employee_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS custody_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CSR-' || lpad(nextval('custody_settlement_code_seq')::TEXT,8,'0')),
  custody_id UUID NOT NULL REFERENCES employee_custodies(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  returned_quantity NUMERIC(18,4) NOT NULL CHECK (returned_quantity > 0),
  damage_value NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (damage_value >= 0),
  shortage_value NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (shortage_value >= 0),
  status TEXT NOT NULL CHECK (status IN ('PARTIAL','FULL','DAMAGED','LOST')),
  notes TEXT,
  settled_by UUID NOT NULL REFERENCES users(id),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custody_settlements_custody
  ON custody_settlements(custody_id,settled_at DESC);

ALTER TABLE advance_requests
  ADD COLUMN IF NOT EXISTS repayment_method TEXT NOT NULL DEFAULT 'CUSTOM'
    CHECK (repayment_method IN ('FIXED_INSTALLMENT','PRODUCTION_PERCENTAGE','CUSTOM')),
  ADD COLUMN IF NOT EXISTS installment_amount NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS production_percentage NUMERIC(7,4),
  ADD COLUMN IF NOT EXISTS repayment_status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (repayment_status IN ('OPEN','SETTLED'));

CREATE TABLE IF NOT EXISTS advance_repayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id UUID NOT NULL REFERENCES advance_requests(id),
  code TEXT NOT NULL UNIQUE DEFAULT ('ARP-' || lpad(nextval('advance_request_code_seq')::TEXT,8,'0')),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  repayment_type TEXT NOT NULL DEFAULT 'CUSTOM' CHECK (repayment_type IN ('FIXED_INSTALLMENT','PRODUCTION_PERCENTAGE','CUSTOM')),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advance_repayments_advance
  ON advance_repayments(advance_id,payment_date DESC,created_at DESC);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('custody.view','hr','custody','view','all'),
 ('custody.view_own','hr','custody','view','own'),
 ('custody.create','hr','custody','create','all'),
 ('custody.settle','hr','custody','settle','all'),
 ('advances.repay','payroll','advance','repay','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','finance','accountant','hr')
  AND p.code IN ('custody.view','custody.create','custody.settle','advances.repay')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','finance','accountant')
  AND p.code IN ('advances.create')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='worker' AND p.code IN ('custody.view_own','advances.view_own')
ON CONFLICT DO NOTHING;

-- Advances are administrative records: workers never create them.
DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE code='worker')
  AND permission_id IN (SELECT id FROM permissions WHERE code='advances.create');

INSERT INTO schema_migrations(version)
VALUES ('026_operational_finance_custody')
ON CONFLICT(version) DO NOTHING;
