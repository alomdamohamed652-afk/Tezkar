-- Employee role: staff see only their own salary slip, attendance, punches, schedule and permission requests.
-- Earlier migrations granted permissions to a role code 'employee' that was never created, so those grants matched nothing.
INSERT INTO roles(code,name,is_system,is_active)
VALUES ('employee','موظف',TRUE,TRUE)
ON CONFLICT(code) DO NOTHING;

INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('attendance.view_own','attendance','attendance','view','own')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code='employee'
   AND p.code IN ('attendance.view_own','payroll.view_own','attendance.permission.request','attendance.permission.view_own')
ON CONFLICT DO NOTHING;

-- Existing worker and shift_leader roles see their own attendance too (own scope only, no manager rights).
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code IN ('worker','shift_leader')
   AND p.code='attendance.view_own'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026112301_employee_role_self_service')
ON CONFLICT(version) DO NOTHING;
