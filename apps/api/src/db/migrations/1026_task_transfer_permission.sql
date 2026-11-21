-- Task transfer is a separate privilege; task editing alone must not grant it.
INSERT INTO permissions(code, module, entity, action, scope)
VALUES ('tasks.transfer', 'tasks', 'task', 'transfer', 'all')
ON CONFLICT (code) DO NOTHING;

-- Grant by default only to the manager role. Other roles can receive this
-- permission explicitly through the role-permission management screen.
INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'manager'
  AND p.code = 'tasks.transfer'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1026_task_transfer_permission')
ON CONFLICT (version) DO NOTHING;
