ALTER TABLE attendance_punches
  ADD COLUMN IF NOT EXISTS corrected_status TEXT,
  ADD COLUMN IF NOT EXISTS correction_decision TEXT,
  ADD COLUMN IF NOT EXISTS correction_reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS correction_reviewed_at TIMESTAMPTZ;

ALTER TABLE attendance_punches
  ADD CONSTRAINT attendance_punches_corrected_status_chk
    CHECK (corrected_status IS NULL OR corrected_status IN ('IN','OUT')),
  ADD CONSTRAINT attendance_punches_correction_decision_chk
    CHECK (correction_decision IS NULL OR correction_decision IN ('APPLIED','KEPT_ORIGINAL'));

CREATE INDEX IF NOT EXISTS attendance_punches_correction_review_idx
  ON attendance_punches (correction_decision, punch_at)
  WHERE status IN ('IN','OUT');
