-- Attendance and payroll attendance data must not be readable through the Supabase Data API.
-- The application accesses these tables only through the authenticated Fastify API.
ALTER TABLE public.attendance_employee_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_weekly_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_schedule_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_weekly_schedule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_permission_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_day_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_attendance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_payroll_attendance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_attendance_calculations ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version)
VALUES ('2026110604_attendance_payroll_rls')
ON CONFLICT(version) DO NOTHING;
