CREATE TABLE IF NOT EXISTS attendance_day_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  attendance_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('PRESENT','ABSENT','DAY_OFF','MISSING_PUNCH','MANUAL')),
  first_in time,
  last_out time,
  worked_minutes integer NOT NULL DEFAULT 0 CHECK (worked_minutes BETWEEN 0 AND 1440),
  late_minutes integer NOT NULL DEFAULT 0 CHECK (late_minutes BETWEEN 0 AND 1440),
  early_minutes integer NOT NULL DEFAULT 0 CHECK (early_minutes BETWEEN 0 AND 1440),
  note text NOT NULL CHECK (length(trim(note)) >= 2),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employee_id, attendance_date),
  CHECK (first_in IS NULL OR last_out IS NULL OR last_out >= first_in OR worked_minutes > 0)
);
CREATE INDEX IF NOT EXISTS attendance_day_overrides_date_idx ON attendance_day_overrides(attendance_date, employee_id);
