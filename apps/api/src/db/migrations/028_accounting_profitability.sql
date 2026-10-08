-- Tezkar profitability/accounting bridge
CREATE SEQUENCE IF NOT EXISTS expense_code_seq START 1;

CREATE TABLE IF NOT EXISTS accounting_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('EXP-' || lpad(nextval('expense_code_seq')::TEXT,8,'0')),
  order_id UUID NULL REFERENCES production_orders(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method TEXT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounting_expenses_order_date
  ON accounting_expenses(order_id,expense_date DESC);

CREATE TABLE IF NOT EXISTS order_revenues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  revenue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT NOT NULL DEFAULT 'MANUAL',
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_revenues_order_date
  ON order_revenues(order_id,revenue_date DESC);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('finance.expenses.view','finance','expense','view','all'),
 ('finance.expenses.create','finance','expense','create','all'),
 ('finance.revenues.view','finance','revenue','view','all'),
 ('finance.revenues.create','finance','revenue','create','all'),
 ('finance.profitability.view','finance','profitability','view','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','finance','accountant')
  AND p.code IN ('finance.expenses.view','finance.expenses.create','finance.revenues.view','finance.revenues.create','finance.profitability.view')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('028_accounting_profitability')
ON CONFLICT(version) DO NOTHING;
