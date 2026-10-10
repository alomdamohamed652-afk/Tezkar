-- Tezkar finance: link cash custody movements to their source and support period-end administrative allocations.

ALTER TABLE accounting_expenses
  ADD COLUMN IF NOT EXISTS expense_type TEXT NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN IF NOT EXISTS paid_from_employee_id UUID REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS cash_custody_transaction_id UUID REFERENCES cash_custody_transactions(id);

ALTER TABLE order_revenues
  ADD COLUMN IF NOT EXISTS collected_by_employee_id UUID REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS cash_custody_transaction_id UUID REFERENCES cash_custody_transactions(id);

ALTER TABLE cash_custody_transactions
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounting_expenses_expense_type_check') THEN
    ALTER TABLE accounting_expenses
      ADD CONSTRAINT accounting_expenses_expense_type_check
      CHECK (expense_type IN ('DIRECT','ADMINISTRATIVE'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_custody_source_movement
  ON cash_custody_transactions(source_type,source_id,direction)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

CREATE SEQUENCE IF NOT EXISTS accounting_period_code_seq START WITH 1;

CREATE TABLE IF NOT EXISTS accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('PER-' || lpad(nextval('accounting_period_code_seq')::TEXT,8,'0')),
  name TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  CHECK (period_end >= period_start),
  CHECK ((status='OPEN' AND closed_at IS NULL) OR (status='CLOSED' AND closed_at IS NOT NULL))
);


CREATE TABLE IF NOT EXISTS accounting_expense_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  expense_id UUID NOT NULL REFERENCES accounting_expenses(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  amount NUMERIC(18,4) NOT NULL CHECK (amount >= 0),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(period_id,expense_id,order_id)
);

CREATE INDEX IF NOT EXISTS idx_accounting_periods_dates
  ON accounting_periods(period_start,period_end,status);
CREATE INDEX IF NOT EXISTS idx_accounting_allocations_period
  ON accounting_expense_allocations(period_id,expense_id);
CREATE INDEX IF NOT EXISTS idx_accounting_allocations_order
  ON accounting_expense_allocations(order_id,period_id);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('finance.period_close.view','finance','period_close','view','all'),
 ('finance.period_close.create','finance','period_close','create','all')
ON CONFLICT(code) DO NOTHING;

-- Grant period settlement to roles that already have finance responsibilities,
-- rather than relying on role display names or hard-coded role codes.
INSERT INTO role_permissions(role_id,permission_id)
SELECT DISTINCT existing_rp.role_id,new_permission.id
FROM role_permissions existing_rp
JOIN permissions existing_permission ON existing_permission.id=existing_rp.permission_id
JOIN permissions new_permission ON new_permission.code IN ('finance.period_close.view','finance.period_close.create')
WHERE existing_permission.code IN ('finance.expenses.view','finance.expenses.create','finance.revenues.view','finance.revenues.create','finance.profitability.view')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1017_custody_revenue_period_close')
ON CONFLICT(version) DO NOTHING;
