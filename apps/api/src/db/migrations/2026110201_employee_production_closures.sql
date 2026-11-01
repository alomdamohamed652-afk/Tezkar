CREATE TABLE IF NOT EXISTS employee_production_closures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVERSED')),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT NOT NULL,
  approved_production_count INTEGER NOT NULL DEFAULT 0,
  production_amount_snapshot NUMERIC(14,2) NOT NULL DEFAULT 0,
  closed_by UUID REFERENCES users(id),
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id),
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employee_production_closures_one_active_per_employee
  ON employee_production_closures(employee_id) WHERE status='ACTIVE';
CREATE TABLE IF NOT EXISTS employee_production_closure_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closure_id UUID NOT NULL REFERENCES employee_production_closures(id) ON DELETE RESTRICT,
  production_entry_id UUID NOT NULL REFERENCES production_entries(id) ON DELETE RESTRICT,
  earned_amount_snapshot NUMERIC(14,4) NOT NULL,
  previously_paid_snapshot NUMERIC(14,4) NOT NULL,
  closed_amount_snapshot NUMERIC(14,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(closure_id, production_entry_id)
);
CREATE INDEX IF NOT EXISTS employee_production_closure_entries_production_idx
  ON employee_production_closure_entries(production_entry_id);
