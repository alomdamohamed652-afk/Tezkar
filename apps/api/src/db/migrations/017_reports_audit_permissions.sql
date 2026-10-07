INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('reports.view','reports','report','view','all'),
 ('audit.view','audit','audit_log','view','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p
WHERE r.code IN ('manager','finance','accountant','production_manager','supervisor','hr','warehouse_manager')
  AND p.code IN ('reports.view','audit.view')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('017_reports_audit_permissions')
ON CONFLICT(version) DO NOTHING;
