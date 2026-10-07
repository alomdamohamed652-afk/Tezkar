CREATE SEQUENCE IF NOT EXISTS advance_request_code_seq START 1;

CREATE TABLE IF NOT EXISTS advance_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('ADV-' || lpad(nextval('advance_request_code_seq')::TEXT,8,'0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PAID','CANCELLED')),
  requested_by UUID NOT NULL REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  paid_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  ledger_entry_id UUID REFERENCES employee_earnings_ledger(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advance_requests_employee_status
  ON advance_requests(employee_id,status,created_at DESC);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('advances.view','payroll','advance','view','all'),
 ('advances.view_own','payroll','advance','view','own'),
 ('advances.create','payroll','advance','create','own'),
 ('advances.approve','payroll','advance','approve','all'),
 ('advances.reject','payroll','advance','reject','all'),
 ('advances.pay','payroll','advance','pay','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='advances.view'
WHERE r.code IN ('manager','finance','accountant')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='advances.view_own'
WHERE r.code='worker'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p
WHERE r.code='worker' AND p.code='advances.create'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p
WHERE r.code IN ('manager','finance') AND p.code IN ('advances.approve','advances.reject','advances.pay')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('013_advances')
ON CONFLICT(version) DO NOTHING;
