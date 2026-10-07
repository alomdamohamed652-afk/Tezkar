DELETE FROM role_permissions
WHERE role_id=(SELECT id FROM roles WHERE code='worker')
  AND permission_id IN (
    SELECT id FROM permissions WHERE code IN ('production.view','production.create')
  );

INSERT INTO schema_migrations(version) VALUES ('023_worker_ui_permissions')
ON CONFLICT (version) DO NOTHING;
