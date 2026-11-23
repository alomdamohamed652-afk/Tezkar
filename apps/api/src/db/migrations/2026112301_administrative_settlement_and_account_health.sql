-- Administrative (non-cash) settlement of a worker's earnings-ledger balance, plus the account-health scan permission.
CREATE TABLE IF NOT EXISTS employee_administrative_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('ADS-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10))),
  employee_id UUID NOT NULL REFERENCES employees(id),
  ledger_id UUID NOT NULL UNIQUE REFERENCES employee_earnings_ledger(id),
  direction TEXT NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  balance_before NUMERIC(18,4) NOT NULL,
  balance_after NUMERIC(18,4) NOT NULL CHECK (balance_after = 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 5),
  employee_was_active BOOLEAN NOT NULL,
  idempotency_key UUID NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_admin_settlements_employee ON employee_administrative_settlements(employee_id, created_at DESC);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('earnings.administrative_settlement.create','production','administrative_settlement','create','all'),
 ('admin.account_health.view','admin','account_health','view','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager')
  AND p.code IN ('earnings.administrative_settlement.create','admin.account_health.view')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026112301_administrative_settlement_and_account_health')
ON CONFLICT(version) DO NOTHING;
