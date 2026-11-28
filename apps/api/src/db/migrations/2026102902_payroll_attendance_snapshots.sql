-- Freeze the reviewed daily attendance report on each payroll item at approval time.
CREATE TABLE IF NOT EXISTS payroll_attendance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_item_id UUID NOT NULL REFERENCES payroll_items(id) ON DELETE RESTRICT,
  attendance_date DATE NOT NULL,
  snapshot_data JSONB NOT NULL CHECK (jsonb_typeof(snapshot_data) = 'object'),
  captured_by UUID NOT NULL REFERENCES users(id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payroll_item_id, attendance_date)
);
CREATE INDEX IF NOT EXISTS idx_payroll_attendance_snapshots_date
  ON payroll_attendance_snapshots(attendance_date, payroll_item_id);

INSERT INTO schema_migrations(version) VALUES ('2026102902_payroll_attendance_snapshots')
ON CONFLICT(version) DO NOTHING;
