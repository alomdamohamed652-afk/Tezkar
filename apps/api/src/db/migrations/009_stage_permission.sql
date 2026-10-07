INSERT INTO permissions(code,module,entity,action,scope) VALUES ('stages.create','production','stage','create','all') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='manager' AND p.code='stages.create' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='stages.create' WHERE r.code IN ('production_manager') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES('009_stage_create_permission') ON CONFLICT(version) DO NOTHING;
