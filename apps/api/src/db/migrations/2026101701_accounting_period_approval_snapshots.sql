-- Quarterly accounting close workflow and immutable period snapshots.
-- Existing accounting_periods are extended in place; no parallel period system is created.

ALTER TABLE accounting_periods
  DROP CONSTRAINT IF EXISTS accounting_periods_status_check,
  DROP CONSTRAINT IF EXISTS accounting_periods_check1,
  DROP CONSTRAINT IF EXISTS accounting_periods_check_1;

ALTER TABLE accounting_periods
  ADD CONSTRAINT accounting_periods_status_check
  CHECK (status IN ('OPEN','UNDER_REVIEW','READY_FOR_APPROVAL','CLOSED')),
  ADD CONSTRAINT accounting_periods_close_timestamp_check
  CHECK (
    (status='CLOSED' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
    OR (status<>'CLOSED' AND closed_at IS NULL AND closed_by IS NULL)
  );

ALTER TABLE accounting_periods
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopen_reason TEXT;

CREATE TABLE IF NOT EXISTS accounting_period_close_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  snapshot_no INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_no > 0),
  report JSONB NOT NULL,
  report_sha256 TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(period_id,snapshot_no)
);

CREATE TABLE IF NOT EXISTS accounting_period_opening_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  source_period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  balance_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  balance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(period_id,balance_type,entity_key),
  CHECK (period_id <> source_period_id)
);

CREATE INDEX IF NOT EXISTS idx_accounting_opening_balances_period
  ON accounting_period_opening_balances(period_id,balance_type);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('finance.period_close.review','finance','period_close','review','all'),
 ('finance.period_close.approve','finance','period_close','approve','all'),
 ('finance.period_close.reopen','finance','period_close','reopen','all')
ON CONFLICT(code) DO NOTHING;

-- Accountants can prepare/review. Final approval and reopening are restricted to management.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('accountant','finance')
  AND p.code IN ('finance.period_close.view','finance.period_close.create','finance.period_close.review')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager')
  AND p.code IN ('finance.period_close.view','finance.period_close.create','finance.period_close.approve','finance.period_close.reopen')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026101701_accounting_period_approval_snapshots')
ON CONFLICT(version) DO NOTHING;
