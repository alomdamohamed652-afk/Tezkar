-- Quarterly financial close workflow: accountant review, manager approval, and traceable opening balances.
ALTER TABLE accounting_periods
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS review_submitted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_notes TEXT,
  ADD COLUMN IF NOT EXISTS close_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS closing_balances JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounting_periods_review_status_check') THEN
    ALTER TABLE accounting_periods
      ADD CONSTRAINT accounting_periods_review_status_check
      CHECK (review_status IN ('DRAFT','SUBMITTED','APPROVED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS accounting_period_opening_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  source_period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  balance_type TEXT NOT NULL CHECK (balance_type IN ('CUSTODY','ADVANCE','WORKER_ENTITLEMENT','INVENTORY')),
  entity_key TEXT NOT NULL,
  entity_id UUID,
  label TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity NUMERIC(18,4),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(period_id,balance_type,entity_key)
);

CREATE INDEX IF NOT EXISTS idx_period_opening_balances_period
  ON accounting_period_opening_balances(period_id,balance_type);

INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('finance.period_close.approve','finance','period_close','approve','all')
ON CONFLICT(code) DO NOTHING;

-- Final approval belongs to manager/admin roles, not every user who can prepare a period.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='finance.period_close.approve'
WHERE upper(r.code) LIKE '%MANAGER%'
   OR upper(r.code) LIKE '%ADMIN%'
   OR r.name ILIKE '%مدير%'
   OR r.name ILIKE '%الإدارة%'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1018_quarterly_period_close_rollover')
ON CONFLICT(version) DO NOTHING;
