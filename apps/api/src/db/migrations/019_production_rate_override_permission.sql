INSERT INTO permissions (code, module, entity, action, scope)
VALUES ('production.rate_override', 'production', 'rate', 'override', 'all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'production.rate_override'
WHERE r.code IN ('manager', 'production_manager')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('019_production_rate_override_permission')
ON CONFLICT (version) DO NOTHING;
