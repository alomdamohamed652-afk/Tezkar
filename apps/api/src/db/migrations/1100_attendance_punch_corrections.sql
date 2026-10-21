ALTER TABLE attendance_punches
  ADD COLUMN IF NOT EXISTS corrected_status TEXT,
  ADD COLUMN IF NOT EXISTS correction_decision TEXT NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN IF NOT EXISTS correction_note TEXT,
  ADD COLUMN IF NOT EXISTS correction_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correction_reviewed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_punches_corrected_status_check'
  ) THEN
    ALTER TABLE attendance_punches
      ADD CONSTRAINT attendance_punches_corrected_status_check
      CHECK (corrected_status IS NULL OR corrected_status IN ('IN','OUT','OVERTIME_IN','OVERTIME_OUT','UNKNOWN'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_punches_correction_decision_check'
  ) THEN
    ALTER TABLE attendance_punches
      ADD CONSTRAINT attendance_punches_correction_decision_check
      CHECK (correction_decision IN ('UNREVIEWED','APPLIED','KEPT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS attendance_punches_correction_review_idx
  ON attendance_punches (correction_decision, punch_at DESC);
