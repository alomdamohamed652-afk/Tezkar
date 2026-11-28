-- Allow monthly target segments to be split when a target changes mid-month.
DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid='laser_machine_targets'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%date_trunc%'
  LOOP
    EXECUTE format('ALTER TABLE laser_machine_targets DROP CONSTRAINT %I',constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE laser_machine_targets
  ADD CONSTRAINT laser_machine_targets_month_bounds_check
  CHECK (
    period_type <> 'MONTH' OR (
      date_trunc('month',effective_from)::date = date_trunc('month',effective_to)::date
      AND effective_to <= (date_trunc('month',effective_from) + interval '1 month' - interval '1 day')::date
    )
  );

INSERT INTO schema_migrations(version) VALUES ('2006_laser_target_history') ON CONFLICT(version) DO NOTHING;
