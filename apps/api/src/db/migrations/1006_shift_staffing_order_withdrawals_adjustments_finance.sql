-- Tezkar v0.7: shift staffing, order-linked shift withdrawals, worker adjustments, general finance income

CREATE TABLE IF NOT EXISTS shift_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  starts_on DATE,
  ends_on DATE,
  assigned_by UUID REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  UNIQUE (shift_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_shift_employees_shift_active
  ON shift_employees(shift_id,is_active);
CREATE INDEX IF NOT EXISTS idx_shift_employees_employee_active
  ON shift_employees(employee_id,is_active);

ALTER TABLE shift_withdrawals
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES production_orders(id),
  ADD COLUMN IF NOT EXISTS order_stage_id UUID REFERENCES order_stages(id);

ALTER TABLE shift_withdrawal_lines
  ALTER COLUMN location_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shift_withdrawals_order
  ON shift_withdrawals(order_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shift_withdrawals_employee
  ON shift_withdrawals(employee_id,withdrawal_date DESC);

CREATE TABLE IF NOT EXISTS employee_earnings_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('ADJ-' || lpad(nextval('employee_earning_code_seq')::text,8,'0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  shift_id UUID REFERENCES shifts(id),
  production_entry_id UUID REFERENCES production_entries(id),
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('BONUS','DEDUCTION')),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ledger_id UUID REFERENCES employee_earnings_ledger(id),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_adjustments_employee_date
  ON employee_earnings_adjustments(employee_id,adjustment_date DESC,created_at DESC);

ALTER TABLE order_revenues
  ALTER COLUMN order_id DROP NOT NULL;

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('shifts.assign_employee','hr','shift_employee','assign','all'),
 ('production.adjustments.view','production','employee_adjustment','view','all'),
 ('production.adjustments.create','production','employee_adjustment','create','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','production_manager','supervisor','hr','finance','accountant')
  AND p.code IN ('shifts.assign_employee','production.adjustments.view','production.adjustments.create')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1006_shift_staffing_order_withdrawals_adjustments_finance')
ON CONFLICT(version) DO NOTHING;
