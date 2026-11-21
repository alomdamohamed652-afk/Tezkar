-- Explicit permission for machine output that is not linked to a customer order stage.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('machine_production.general_stock.create','machine_production','machine_production','create_general_stock','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','production_manager')
  AND p.code='machine_production.general_stock.create'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('2004_laser_general_stock_production') ON CONFLICT(version) DO NOTHING;
