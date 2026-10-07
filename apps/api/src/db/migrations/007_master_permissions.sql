INSERT INTO permissions (code,module,entity,action,scope) VALUES
('shifts.view','hr','shift','view','all'),('shifts.create','hr','shift','create','all'),('shifts.assign_leader','hr','shift_leader','assign','all'),
('products.view','master_data','product','view','all'),('products.create','master_data','product','create','all'),
('rates.view','production','rate','view','all'),('rates.create','production','rate','create','all')
ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager' AND p.code IN ('shifts.view','shifts.create','shifts.assign_leader','products.view','products.create','rates.view','rates.create')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN ('shifts.view','shifts.create','shifts.assign_leader')
WHERE r.code IN ('hr','production_manager','supervisor')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN ('products.view')
WHERE r.code IN ('warehouse_manager','warehouse_staff','production_manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code IN ('rates.view')
WHERE r.code IN ('production_manager','supervisor')
ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES('007_master_permissions') ON CONFLICT(version) DO NOTHING;