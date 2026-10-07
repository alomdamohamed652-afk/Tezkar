CREATE SEQUENCE IF NOT EXISTS employee_earning_code_seq START 1;

CREATE TABLE IF NOT EXISTS employee_earnings_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('EARN-' || lpad(nextval('employee_earning_code_seq')::TEXT, 8, '0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('PRODUCTION_APPROVAL','WORKER_PAYMENT','ADJUSTMENT')),
  credit_amount NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  debit_amount NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  production_entry_id UUID REFERENCES production_entries(id),
  worker_payment_id UUID REFERENCES worker_payments(id),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employee_earnings_one_side_chk CHECK (
    (credit_amount > 0 AND debit_amount = 0)
    OR (debit_amount > 0 AND credit_amount = 0)
  ),
  CONSTRAINT employee_earnings_source_chk CHECK (
    (entry_type = 'PRODUCTION_APPROVAL' AND production_entry_id IS NOT NULL AND worker_payment_id IS NULL)
    OR (entry_type = 'WORKER_PAYMENT' AND worker_payment_id IS NOT NULL AND production_entry_id IS NULL)
    OR (entry_type = 'ADJUSTMENT' AND production_entry_id IS NULL AND worker_payment_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_production
  ON employee_earnings_ledger(production_entry_id)
  WHERE production_entry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_payment
  ON employee_earnings_ledger(worker_payment_id)
  WHERE worker_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employee_earnings_employee_date
  ON employee_earnings_ledger(employee_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_employee_earnings_employee
  ON employee_earnings_ledger(employee_id);

INSERT INTO employee_earnings_ledger (
  employee_id, entry_type, credit_amount, production_entry_id, created_by, notes
)
SELECT
  p.employee_id,
  'PRODUCTION_APPROVAL',
  p.earning_amount,
  p.id,
  p.approved_by,
  'Backfilled from approved production'
FROM production_entries p
WHERE p.status = 'APPROVED'
  AND p.approved_by IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO employee_earnings_ledger (
  employee_id, entry_type, debit_amount, worker_payment_id, created_by, notes
)
SELECT
  w.employee_id,
  'WORKER_PAYMENT',
  w.amount,
  w.id,
  w.paid_by,
  'Backfilled from worker payment'
FROM worker_payments w
ON CONFLICT DO NOTHING;

INSERT INTO permissions(code,module,entity,action,scope) VALUES
  ('earnings.view','payroll','employee_earnings','view','all'),
  ('earnings.view_own','payroll','employee_earnings','view','own')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='earnings.view'
WHERE r.code IN ('manager','finance','accountant')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='earnings.view_own'
WHERE r.code='worker'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('010_employee_earnings_ledger')
ON CONFLICT(version) DO NOTHING;
