-- A pending, rejected, or cancelled permission must never carry a payroll classification.
-- Keep this as a new migration: 2026110501 may already be recorded on existing databases.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.attendance_permission_requests'::regclass
       AND conname='attendance_permission_classification_by_status'
  ) THEN
    ALTER TABLE public.attendance_permission_requests
      ADD CONSTRAINT attendance_permission_classification_by_status
      CHECK (
        (status = 'APPROVED' AND permission_type IS NOT NULL)
        OR (status <> 'APPROVED' AND permission_type IS NULL)
      );
  END IF;
END;
$$;

INSERT INTO schema_migrations(version)
VALUES ('2026110605_attendance_permission_classification_by_status')
ON CONFLICT(version) DO NOTHING;
