-- Append-only financial reversal journal. Original source records are never deleted or rewritten.
ALTER TABLE advance_repayments
  ADD COLUMN IF NOT EXISTS source_payroll_payment_id UUID
  REFERENCES payroll_payments(id) ON DELETE RESTRICT;

-- Historical payroll repayments were committed in the same transaction as the final payment.
-- Link them to that final payment so a reversal can unwind the exact bundle.
WITH latest_payment AS (
  SELECT DISTINCT ON (payroll_item_id) payroll_item_id,id
  FROM payroll_payments
  ORDER BY payroll_item_id,created_at DESC,id DESC
)
UPDATE advance_repayments ar
   SET source_payroll_payment_id=lp.id
  FROM latest_payment lp
 WHERE ar.source_payroll_item_id=lp.payroll_item_id
   AND ar.source_payroll_payment_id IS NULL;

-- A payroll item can be paid again after its previous payment is reversed.
-- Scope uniqueness to the actual payment, not the payroll item, so the new settlement is append-only.
DROP INDEX IF EXISTS uq_advance_repayments_source_payroll_item_advance;
CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_source_payment_advance
  ON advance_repayments(source_payroll_payment_id,advance_id)
  WHERE source_payroll_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_advance_repayments_source_payroll_payment
  ON advance_repayments(source_payroll_payment_id)
  WHERE source_payroll_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS financial_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('REV-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))),
  idempotency_key UUID NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 2),
  reversal_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_reversal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reversal_id UUID NOT NULL REFERENCES financial_reversals(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN ('PAYROLL_PAYMENT','ADVANCE_REPAYMENT')),
  source_id UUID NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reversal_id,source_type,source_id)
);

CREATE INDEX IF NOT EXISTS idx_financial_reversal_lines_source
  ON financial_reversal_lines(source_type,source_id);

INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('finance.reversals.create','finance','financial_reversal','create','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.code IN ('admin','manager','finance','accountant')
   AND p.code='finance.reversals.create'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026110607_financial_reversals')
ON CONFLICT(version) DO NOTHING;
