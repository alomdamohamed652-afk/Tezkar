-- Append-only effects for worker-payment reversals.
-- Original payment, allocation and expense rows remain immutable.
ALTER TABLE employee_earnings_ledger
  ADD COLUMN IF NOT EXISTS financial_reversal_id UUID
  REFERENCES financial_reversals(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS employee_earnings_ledger_financial_reversal_idx
  ON employee_earnings_ledger(financial_reversal_id)
  WHERE financial_reversal_id IS NOT NULL;

ALTER TABLE financial_reversal_lines
  DROP CONSTRAINT IF EXISTS financial_reversal_lines_source_type_check;

ALTER TABLE financial_reversal_lines
  ADD CONSTRAINT financial_reversal_lines_source_type_check
  CHECK (source_type IN (
    'PAYROLL_PAYMENT',
    'ADVANCE_REPAYMENT',
    'ZERO_NET_PAYROLL_SETTLEMENT',
    'WORKER_PAYMENT'
  ));

CREATE TABLE IF NOT EXISTS worker_payment_allocation_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reversal_id UUID NOT NULL REFERENCES financial_reversals(id) ON DELETE RESTRICT,
  worker_payment_id UUID NOT NULL REFERENCES worker_payments(id) ON DELETE RESTRICT,
  allocation_source TEXT NOT NULL CHECK (
    allocation_source IN (
      'EMPLOYEE_EARNINGS_SETTLEMENT',
      'WORKER_PAYMENT_ORDER',
      'WORKER_PAYMENT_LEGACY'
    )
  ),
  source_allocation_id UUID NOT NULL,
  production_entry_id UUID NOT NULL REFERENCES production_entries(id) ON DELETE RESTRICT,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reversal_id, allocation_source, source_allocation_id)
);

CREATE INDEX IF NOT EXISTS worker_payment_allocation_reversals_source_idx
  ON worker_payment_allocation_reversals(allocation_source, source_allocation_id);

CREATE INDEX IF NOT EXISTS worker_payment_allocation_reversals_production_idx
  ON worker_payment_allocation_reversals(production_entry_id);

CREATE INDEX IF NOT EXISTS worker_payment_allocation_reversals_payment_idx
  ON worker_payment_allocation_reversals(worker_payment_id);

CREATE UNIQUE INDEX IF NOT EXISTS worker_payment_allocation_reversals_source_uq
  ON worker_payment_allocation_reversals(allocation_source, source_allocation_id);

CREATE TABLE IF NOT EXISTS accounting_expense_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reversal_id UUID NOT NULL REFERENCES financial_reversals(id) ON DELETE RESTRICT,
  expense_id UUID NOT NULL REFERENCES accounting_expenses(id) ON DELETE RESTRICT,
  source_worker_payment_id UUID NOT NULL REFERENCES worker_payments(id) ON DELETE RESTRICT,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reversal_id, expense_id)
);

CREATE INDEX IF NOT EXISTS accounting_expense_reversals_expense_idx
  ON accounting_expense_reversals(expense_id);

CREATE INDEX IF NOT EXISTS accounting_expense_reversals_payment_idx
  ON accounting_expense_reversals(source_worker_payment_id);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_expense_reversals_expense_uq
  ON accounting_expense_reversals(expense_id);

INSERT INTO schema_migrations(version)
VALUES ('2026111102_worker_payment_reversal_effects')
ON CONFLICT(version) DO NOTHING;
