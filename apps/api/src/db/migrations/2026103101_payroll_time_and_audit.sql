-- Detailed payroll audit and attendance-based time compensation.
ALTER TABLE payroll_periods
  ADD COLUMN IF NOT EXISTS overtime_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.500
  CHECK (overtime_multiplier >= 1 AND overtime_multiplier <= 5);

ALTER TABLE payroll_adjustment_lines
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','VOIDED')),
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (source_type IN ('MANUAL','ATTENDANCE_TIME_DEDUCTION','ATTENDANCE_OVERTIME'));

ALTER TABLE payroll_adjustment_lines
  ADD CONSTRAINT payroll_adjustment_lines_void_metadata_check
  CHECK (
    (status='ACTIVE' AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
    OR
    (status='VOIDED' AND length(trim(COALESCE(void_reason,''))) BETWEEN 2 AND 1000
      AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_adjustment_item_source
  ON payroll_adjustment_lines(payroll_item_id,source_type)
  WHERE source_type <> 'MANUAL';

CREATE INDEX IF NOT EXISTS idx_payroll_adjustment_active_item
  ON payroll_adjustment_lines(payroll_item_id,status,line_type);

INSERT INTO schema_migrations(version)
VALUES ('2026103101_payroll_time_and_audit')
ON CONFLICT(version) DO NOTHING;
