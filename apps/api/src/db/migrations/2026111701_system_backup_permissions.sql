INSERT INTO permissions (code,module,entity,action,scope)
VALUES
  ('system.backup.export','system','system_backup','export','all'),
  ('system.backup.restore','system','system_backup','restore','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code IN ('system.backup.export','system.backup.restore')
WHERE r.code='manager' AND r.is_system=TRUE
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026111701_system_backup_permissions')
ON CONFLICT (version) DO NOTHING;
