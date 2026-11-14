-- Manual attendance corrections must support overtime events as well as regular IN/OUT punches.
ALTER TABLE attendance_punches
  DROP CONSTRAINT IF EXISTS attendance_punches_corrected_status_chk;

ALTER TABLE attendance_punches
  ADD CONSTRAINT attendance_punches_corrected_status_chk
  CHECK (corrected_status IS NULL OR corrected_status IN ('IN','OUT','OVERTIME_IN','OVERTIME_OUT'));

INSERT INTO schema_migrations(version)
VALUES ('2026110603_attendance_overtime_punch_corrections')
ON CONFLICT(version) DO NOTHING;
