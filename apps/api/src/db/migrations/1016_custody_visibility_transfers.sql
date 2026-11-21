-- Tezkar: assigned custody visibility and controlled custody transfers

CREATE TABLE IF NOT EXISTS employee_custody_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CTR-' || lpad(nextval('custody_settlement_code_seq')::TEXT,8,'0')),
  custody_id UUID NOT NULL REFERENCES employee_custodies(id),
  from_employee_id UUID NOT NULL REFERENCES employees(id),
  to_employee_id UUID NOT NULL REFERENCES employees(id),
  remaining_quantity NUMERIC(18,4) NOT NULL CHECK (remaining_quantity > 0),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_employee_id <> to_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_employee_custody_transfers_custody
  ON employee_custody_transfers(custody_id,created_at DESC);

CREATE TABLE IF NOT EXISTS cash_custody_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CCTF-' || lpad(nextval('cash_custody_transaction_code_seq')::TEXT,8,'0')),
  from_employee_id UUID NOT NULL REFERENCES employees(id),
  to_employee_id UUID NOT NULL REFERENCES employees(id),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_employee_id <> to_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_cash_custody_transfers_date
  ON cash_custody_transfers(transaction_date DESC,created_at DESC);

ALTER TABLE cash_custody_transactions
  ADD COLUMN IF NOT EXISTS transfer_id UUID REFERENCES cash_custody_transfers(id);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('custody.transfer','hr','custody','transfer','all'),
 ('cash_custody.transfer','finance','cash_custody','transfer','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','finance','accountant')
  AND p.code IN ('custody.transfer','cash_custody.transfer')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1016_custody_visibility_transfers')
ON CONFLICT(version) DO NOTHING;
