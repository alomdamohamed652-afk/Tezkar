-- Preserve payroll adjustment history when a draft line is cancelled.
ALTER TABLE payroll_adjustment_lines
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','VOIDED')),
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

DO $
BEGIN
  -- PR #233's earlier payroll-time migration may already have installed this
  -- constraint. Check the target table, not only the global constraint name.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname='payroll_adjustment_lines_void_metadata_check'
       AND conrelid='payroll_adjustment_lines'::regclass
  ) THEN
    ALTER TABLE payroll_adjustment_lines
      ADD CONSTRAINT payroll_adjustment_lines_void_metadata_check
      CHECK (
        (status='ACTIVE' AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
        OR
        (status='VOIDED' AND length(trim(COALESCE(void_reason,''))) BETWEEN 2 AND 1000
          AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
      );
  END IF;
END
$;

CREATE INDEX IF NOT EXISTS idx_payroll_adjustment_active_item
  ON payroll_adjustment_lines(payroll_item_id,status,line_type);

INSERT INTO schema_migrations(version)
VALUES ('2026110601_payroll_adjustment_void_audit')
ON CONFLICT(version) DO NOTHING;
