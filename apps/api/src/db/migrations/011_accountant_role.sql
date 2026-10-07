INSERT INTO roles (code,name,is_system)
VALUES ('accountant','محاسب',TRUE)
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code='earnings.view'
WHERE r.code='accountant'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('011_accountant_role')
ON CONFLICT(version) DO NOTHING;
