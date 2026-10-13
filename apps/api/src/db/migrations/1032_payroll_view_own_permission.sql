-- Employees can view only their own salary profile and approved payslips.
INSERT INTO permissions(code,name,description,scope)
VALUES (
  'payroll.view_own',
  'عرض الرواتب الشخصية',
  'عرض سجل الراتب الأساسي ومسيرات الرواتب والمدفوعات الخاصة بصاحب الحساب فقط',
  'own'
)
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.code IN ('worker','employee')
   AND p.code='payroll.view_own'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1032_payroll_view_own_permission')
ON CONFLICT(version) DO NOTHING;
