INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('orders.dashboard','orders','order_dashboard','view','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('manager','production_manager','supervisor','finance','accountant','warehouse_manager')
  AND p.code='orders.dashboard'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026110403_order_operational_dashboard_permission')
ON CONFLICT(version) DO NOTHING;
