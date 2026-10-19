-- Preserve weekly schedule changes over time so historical attendance uses the schedule that was active on each date.
CREATE TABLE IF NOT EXISTS attendance_weekly_schedule_versions (
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_at TIME,
  ends_at TIME,
  is_day_off BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (employee_id, effective_from, weekday),
  CHECK (is_day_off OR (starts_at IS NOT NULL AND ends_at IS NOT NULL))
);

-- Existing weekly schedules are the baseline until a dated version is saved.
INSERT INTO attendance_weekly_schedule_versions
  (employee_id, effective_from, weekday, starts_at, ends_at, is_day_off)
SELECT employee_id, DATE '1900-01-01', weekday, starts_at, ends_at, is_day_off
FROM attendance_weekly_schedule
ON CONFLICT (employee_id, effective_from, weekday) DO NOTHING;

CREATE INDEX IF NOT EXISTS attendance_schedule_versions_lookup_idx
  ON attendance_weekly_schedule_versions(employee_id, effective_from DESC, weekday);
