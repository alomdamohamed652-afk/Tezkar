-- Allow attendance permissions that cross midnight (e.g. 23:30 -> 00:30) on overnight schedules.
-- The original CHECK (ends_at > starts_at) made such rows impossible to store; replace it with
-- a check that only rejects an empty window. Cross-midnight semantics: ends_at earlier than
-- starts_at means the permission ends on the day after permission_date.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='public.attendance_permission_requests'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) ILIKE '%ends_at > starts_at%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.attendance_permission_requests DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.attendance_permission_requests'::regclass
       AND conname='attendance_permission_time_window_nonempty'
  ) THEN
    ALTER TABLE public.attendance_permission_requests
      ADD CONSTRAINT attendance_permission_time_window_nonempty
      CHECK (ends_at <> starts_at);
  END IF;
END;
$$;

INSERT INTO schema_migrations(version)
VALUES ('2026112302_attendance_overnight_permissions')
ON CONFLICT(version) DO NOTHING;
