ALTER TABLE attendance_employee_settings
  ADD COLUMN IF NOT EXISTS overnight_checkout_grace_minutes integer NOT NULL DEFAULT 120
  CHECK (overnight_checkout_grace_minutes BETWEEN 0 AND 480);

INSERT INTO schema_migrations(version)
VALUES ('2026110701_attendance_overnight_checkout_grace')
ON CONFLICT (version) DO NOTHING;
