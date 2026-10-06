INSERT INTO roles (code, name, is_system)
VALUES
  ('manager', 'مدير النظام', TRUE),
  ('finance', 'المالية', TRUE),
  ('warehouse_manager', 'مدير المخزن', TRUE),
  ('warehouse_staff', 'موظف مخزن', TRUE),
  ('production_manager', 'مدير الإنتاج', TRUE),
  ('supervisor', 'مشرف', TRUE),
  ('hr', 'الموارد البشرية', TRUE),
  ('coding_station', 'محطة الترميز', TRUE),
  ('worker', 'عامل', TRUE),
  ('read_only', 'قراءة فقط', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, module, entity, action, scope)
VALUES
  ('employees.view', 'employees', 'employee', 'view', 'all'),
  ('employees.create', 'employees', 'employee', 'create', 'all'),
  ('employees.edit', 'employees', 'employee', 'edit', 'all'),
  ('users.view', 'iam', 'user', 'view', 'all'),
  ('users.manage_roles', 'iam', 'user', 'manage_roles', 'all'),
  ('rbac.manage', 'iam', 'permission', 'manage', 'all'),
  ('audit.view', 'audit', 'audit_log', 'view', 'all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('employees.view')
WHERE r.code IN ('hr', 'production_manager', 'supervisor', 'read_only')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('003_rbac_seed')
ON CONFLICT (version) DO NOTHING;
