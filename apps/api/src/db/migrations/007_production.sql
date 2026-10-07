CREATE SEQUENCE IF NOT EXISTS production_code_seq START 1;

CREATE TABLE IF NOT EXISTS production_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('PRD-' || lpad(nextval('production_code_seq')::TEXT, 8, '0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  product_id UUID NOT NULL REFERENCES products(id),
  stage_id UUID NOT NULL REFERENCES stages(id),
  shift_id UUID NOT NULL REFERENCES shifts(id),
  work_date DATE NOT NULL,
  quantity NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  unit_id UUID NOT NULL REFERENCES units(id),

  rate_id UUID NOT NULL REFERENCES rates(id),
  rate_snapshot NUMERIC(18,4) NOT NULL CHECK (rate_snapshot >= 0),
  wage_type_id UUID NOT NULL REFERENCES wage_types(id),
  wage_type_code_snapshot TEXT NOT NULL,
  wage_type_method_snapshot TEXT NOT NULL,
  percentage_base_snapshot TEXT,
  base_amount NUMERIC(18,4) CHECK (base_amount IS NULL OR base_amount >= 0),
  earning_amount NUMERIC(18,4) NOT NULL CHECK (earning_amount >= 0),

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  rejection_reason TEXT,
  submitted_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT production_approval_chk CHECK (
    (status <> 'APPROVED') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT production_rejection_chk CHECK (
    (status <> 'REJECTED') OR rejection_reason IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_production_employee_date
  ON production_entries(employee_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_production_status_date
  ON production_entries(status, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_production_product_stage
  ON production_entries(product_id, stage_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_production_submitted_by
  ON production_entries(submitted_by, created_at DESC);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
('production.view','production','production','view','all'),
('production.create','production','production','create','all'),
('production.approve','production','production','approve','all'),
('production.reject','production','production','reject','all'),
('production.cancel','production','production','cancel','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager'
  AND p.code IN ('production.view','production.create','production.approve','production.reject','production.cancel')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='production_manager'
  AND p.code IN ('production.view','production.create','production.approve','production.reject','production.cancel')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='supervisor'
  AND p.code IN ('production.view','production.approve','production.reject')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='worker'
  AND p.code IN ('production.view','production.create')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('007_production') ON CONFLICT (version) DO NOTHING;
