-- Tezkar v0.7: order profitability extensions and global expense allocation
ALTER TABLE accounting_expenses
  ADD COLUMN IF NOT EXISTS allocation_type TEXT NOT NULL DEFAULT 'DIRECT'
    CHECK (allocation_type IN ('DIRECT','GENERAL')),
  ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE TABLE IF NOT EXISTS order_cost_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL REFERENCES accounting_expenses(id) ON DELETE CASCADE,
  allocated_amount NUMERIC(18,4) NOT NULL CHECK (allocated_amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id,expense_id)
);

CREATE INDEX IF NOT EXISTS idx_order_cost_allocations_order ON order_cost_allocations(order_id);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('finance.allocations.view','finance','allocation','view','all'),
 ('finance.allocations.manage','finance','allocation','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','finance','accountant')
 AND p.code IN ('finance.allocations.view','finance.allocations.manage')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('029_profitability_allocations')
ON CONFLICT(version) DO NOTHING;
