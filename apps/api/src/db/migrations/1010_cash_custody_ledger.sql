-- Tezkar v1.0: cash custody ledger with duplicate-operation confirmation

CREATE SEQUENCE IF NOT EXISTS cash_custody_transaction_code_seq START 1;

CREATE TABLE IF NOT EXISTS cash_custody_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CCT-' || lpad(nextval('cash_custody_transaction_code_seq')::TEXT,8,'0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL,
  notes TEXT,
  confirmed_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_custody_employee_date
  ON cash_custody_transactions(employee_id,transaction_date DESC,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_custody_duplicate_lookup
  ON cash_custody_transactions(employee_id,direction,amount,transaction_date);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('cash_custody.view','finance','cash_custody','view','all'),
 ('cash_custody.view_own','finance','cash_custody','view','own'),
 ('cash_custody.create','finance','cash_custody','create','all'),
 ('cash_custody.create_own','finance','cash_custody','create','own')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','finance','accountant')
  AND p.code IN ('cash_custody.view','cash_custody.create')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='worker'
  AND p.code IN ('cash_custody.view_own','cash_custody.create_own')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1010_cash_custody_ledger')
ON CONFLICT(version) DO NOTHING;
