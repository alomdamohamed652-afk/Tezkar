-- Track the unallocated portion of a worker payment made against a specific order.
-- The original general expense remains immutable; append-only events reassign its cost.
CREATE TABLE IF NOT EXISTS worker_payment_settlement_differences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_payment_id UUID NOT NULL UNIQUE REFERENCES worker_payments(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  source_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  source_order_stage_id UUID REFERENCES order_stages(id) ON DELETE RESTRICT,
  source_expense_id UUID NOT NULL UNIQUE REFERENCES accounting_expenses(id) ON DELETE RESTRICT,
  original_amount NUMERIC(18,4) NOT NULL CHECK (original_amount > 0),
  payment_date DATE NOT NULL,
  eligible_at DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PARTIALLY_ALLOCATED','ALLOCATED','TRANSFERRED_TO_SOURCE_ORDER','REVERSED')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_payment_settlement_differences_due_idx
  ON worker_payment_settlement_differences(status, eligible_at, created_at)
  WHERE status IN ('PENDING','PARTIALLY_ALLOCATED');

CREATE INDEX IF NOT EXISTS worker_payment_settlement_differences_employee_idx
  ON worker_payment_settlement_differences(employee_id, status, created_at);

CREATE TABLE IF NOT EXISTS worker_payment_settlement_difference_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  difference_id UUID NOT NULL REFERENCES worker_payment_settlement_differences(id) ON DELETE RESTRICT,
  worker_payment_id UUID NOT NULL REFERENCES worker_payments(id) ON DELETE RESTRICT,
  source_expense_id UUID NOT NULL REFERENCES accounting_expenses(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('ALLOCATED_TO_PRODUCTION','TRANSFERRED_TO_SOURCE_ORDER','REVERSED')),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  source_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  target_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  target_order_stage_id UUID REFERENCES order_stages(id) ON DELETE RESTRICT,
  production_entry_id UUID REFERENCES production_entries(id) ON DELETE RESTRICT,
  worker_payment_order_allocation_id UUID REFERENCES worker_payment_order_allocations(id) ON DELETE RESTRICT,
  reverses_event_id UUID REFERENCES worker_payment_settlement_difference_events(id) ON DELETE RESTRICT,
  financial_reversal_id UUID REFERENCES financial_reversals(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER','SYSTEM')),
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 2),
  idempotency_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (actor_type='USER' AND actor_user_id IS NOT NULL)
    OR (actor_type='SYSTEM' AND actor_user_id IS NULL)
  ),
  CHECK (
    (event_type='ALLOCATED_TO_PRODUCTION'
      AND production_entry_id IS NOT NULL
      AND worker_payment_order_allocation_id IS NOT NULL
      AND reverses_event_id IS NULL
      AND financial_reversal_id IS NULL)
    OR
    (event_type='TRANSFERRED_TO_SOURCE_ORDER'
      AND production_entry_id IS NULL
      AND worker_payment_order_allocation_id IS NULL
      AND target_order_id=source_order_id
      AND reverses_event_id IS NULL
      AND financial_reversal_id IS NULL)
    OR
    (event_type='REVERSED'
      AND reverses_event_id IS NOT NULL
      AND financial_reversal_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS worker_payment_settlement_difference_events_difference_idx
  ON worker_payment_settlement_difference_events(difference_id, created_at, id);

CREATE INDEX IF NOT EXISTS worker_payment_settlement_difference_events_target_idx
  ON worker_payment_settlement_difference_events(target_order_id, target_order_stage_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS worker_payment_settlement_difference_allocation_uq
  ON worker_payment_settlement_difference_events(difference_id, production_entry_id)
  WHERE event_type='ALLOCATED_TO_PRODUCTION';

CREATE UNIQUE INDEX IF NOT EXISTS worker_payment_settlement_difference_transfer_uq
  ON worker_payment_settlement_difference_events(difference_id)
  WHERE event_type='TRANSFERRED_TO_SOURCE_ORDER';

CREATE UNIQUE INDEX IF NOT EXISTS worker_payment_settlement_difference_reversal_uq
  ON worker_payment_settlement_difference_events(reverses_event_id)
  WHERE event_type='REVERSED';

INSERT INTO permissions(code,module,entity,action,scope)
VALUES
  ('finance.worker_settlement_differences.view','finance','worker_settlement_difference','view','all'),
  ('finance.worker_settlement_differences.manage','finance','worker_settlement_difference','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.code IN ('admin','manager','finance','accountant')
   AND p.code IN ('finance.worker_settlement_differences.view','finance.worker_settlement_differences.manage')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026111103_worker_payment_settlement_differences')
ON CONFLICT(version) DO NOTHING;
