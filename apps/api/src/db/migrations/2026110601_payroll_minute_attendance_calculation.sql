-- Per-employee monthly attendance/pay rules. Defaults match an 8-hour, 26-workday month.
CREATE TABLE IF NOT EXISTS employee_payroll_attendance_policies (
  employee_id UUID PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  work_days_per_month INTEGER NOT NULL DEFAULT 26 CHECK (work_days_per_month BETWEEN 1 AND 31),
  daily_work_minutes INTEGER NOT NULL DEFAULT 480 CHECK (daily_work_minutes BETWEEN 1 AND 1440),
  day_off_pay_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (day_off_pay_amount >= 0),
  overtime_multiplier NUMERIC(8,4) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier BETWEEN 0 AND 5),
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payroll_adjustment_lines
  ADD COLUMN IF NOT EXISTS source_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_adjustment_line_source
  ON payroll_adjustment_lines(payroll_item_id,source_key)
  WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS payroll_attendance_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_item_id UUID NOT NULL UNIQUE REFERENCES payroll_items(id) ON DELETE RESTRICT,
  calculation_data JSONB NOT NULL CHECK (jsonb_typeof(calculation_data)='object'),
  captured_by UUID NOT NULL REFERENCES users(id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations(version) VALUES ('2026110601_payroll_minute_attendance_calculation')
ON CONFLICT(version) DO NOTHING;
