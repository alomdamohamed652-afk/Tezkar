-- Add an auditable two-person review and manual rollover to accounting periods.
ALTER TABLE accounting_periods
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closing_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS opening_balance_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollover_source_period_id UUID REFERENCES accounting_periods(id);

CREATE INDEX IF NOT EXISTS accounting_periods_rollover_source_idx
  ON accounting_periods (rollover_source_period_id)
  WHERE rollover_source_period_id IS NOT NULL;

COMMENT ON COLUMN accounting_periods.closing_snapshot IS
  'Immutable financial close snapshot captured when the manager closes this period.';
COMMENT ON COLUMN accounting_periods.opening_balance_snapshot IS
  'Opening balances copied once from the immediately preceding closed period snapshot; not a new cash movement.';
