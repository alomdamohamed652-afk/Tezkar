INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('dashboard.view','dashboard','dashboard','view','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r JOIN permissions p ON p.code='dashboard.view'
WHERE r.code IN ('manager','finance','accountant','production_manager','supervisor','warehouse_manager')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('016_dashboard_permission')
ON CONFLICT(version) DO NOTHING;
