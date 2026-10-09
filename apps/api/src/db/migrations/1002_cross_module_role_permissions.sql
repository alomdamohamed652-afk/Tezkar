-- Tezkar role integration: permissions required by cross-module operational screens.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('finance','accountant')
  AND p.code IN ('orders.view')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('warehouse_manager','warehouse_staff')
  AND p.code IN ('orders.view','products.view')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code='coding_station'
  AND p.code IN ('cartons.view','cartons.manage','orders.view','products.view','employees.view','warehouse.view')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1002_cross_module_role_permissions')
ON CONFLICT(version) DO NOTHING;
