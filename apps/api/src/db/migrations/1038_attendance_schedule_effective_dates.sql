-- Preserve weekly attendance schedules as effective-dated versions.
CREATE TABLE IF NOT EXISTS attendance_weekly_schedule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_at time,
  ends_at time,
  is_day_off boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL,
  effective_to date,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (is_day_off OR (starts_at IS NOT NULL AND ends_at IS NOT NULL)),
  UNIQUE (employee_id, weekday, effective_from)
);
CREATE INDEX IF NOT EXISTS attendance_schedule_versions_lookup_idx
  ON attendance_weekly_schedule_versions(employee_id, effective_from, effective_to, weekday);

-- Existing schedules remain valid for historical reports and until replaced.
INSERT INTO attendance_weekly_schedule_versions
  (employee_id, weekday, starts_at, ends_at, is_day_off, effective_from)
SELECT employee_id, weekday, starts_at, ends_at, is_day_off, DATE '1900-01-01'
FROM attendance_weekly_schedule
ON CONFLICT (employee_id, weekday, effective_from) DO NOTHING;
