CREATE TABLE IF NOT EXISTS attendance_permission_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  permission_date date NOT NULL,
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 720),
  permission_type text CHECK (permission_type IN ('PAID','UNPAID')),
  reason text NOT NULL CHECK (length(trim(reason)) >= 2),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (status <> 'APPROVED' OR permission_type IS NOT NULL),
  CHECK (
    (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR status <> 'PENDING'
  )
);

CREATE INDEX IF NOT EXISTS attendance_permission_employee_date_idx
  ON attendance_permission_requests(employee_id, permission_date, starts_at);
CREATE INDEX IF NOT EXISTS attendance_permission_status_date_idx
  ON attendance_permission_requests(status, permission_date DESC);

INSERT INTO permissions(code,module,entity,action,scope)
VALUES
  ('attendance.permission.request','attendance','permission','create','own'),
  ('attendance.permission.view_own','attendance','permission','view','own'),
  ('attendance.permission.view','attendance','permission','view','all'),
  ('attendance.permission.review','attendance','permission','review','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('worker','employee','shift_leader')
  AND p.code IN ('attendance.permission.request','attendance.permission.view_own')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','admin','hr')
  AND p.code IN ('attendance.permission.view','attendance.permission.review')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026110501_attendance_employee_permissions')
ON CONFLICT(version) DO NOTHING;
