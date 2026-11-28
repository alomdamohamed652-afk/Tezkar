-- Allow an audited unpaid-leave day in attendance day overrides.
-- Payroll treats UNPAID_LEAVE as a full scheduled-day deduction, kept distinct
-- from ABSENT so unpaid leave is not misreported as absence.
ALTER TABLE attendance_day_overrides DROP CONSTRAINT IF EXISTS attendance_day_overrides_status_check;
ALTER TABLE attendance_day_overrides ADD CONSTRAINT attendance_day_overrides_status_check
  CHECK (status IN ('PRESENT','ABSENT','DAY_OFF','MISSING_PUNCH','MANUAL','UNPAID_LEAVE'));
