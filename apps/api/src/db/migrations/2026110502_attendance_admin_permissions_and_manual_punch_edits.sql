ALTER TABLE attendance_punches
  ADD COLUMN IF NOT EXISTS corrected_punch_at timestamptz,
  ADD COLUMN IF NOT EXISTS correction_note text;

ALTER TABLE attendance_punches
  DROP CONSTRAINT IF EXISTS attendance_punches_correction_decision_chk;

ALTER TABLE attendance_punches
  ADD CONSTRAINT attendance_punches_correction_decision_chk
  CHECK (correction_decision IS NULL OR correction_decision IN ('APPLIED','KEPT_ORIGINAL','MANUAL_APPLIED'));

CREATE INDEX IF NOT EXISTS attendance_punches_corrected_time_idx
  ON attendance_punches(corrected_punch_at)
  WHERE corrected_punch_at IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('2026110502_attendance_admin_permissions_and_manual_punch_edits')
ON CONFLICT(version) DO NOTHING;
