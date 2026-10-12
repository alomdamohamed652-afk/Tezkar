-- Granular cash-custody actions: viewing a personal ledger does not imply write access.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('cash_custody.order_collection','finance','order_collection','create','all'),
 ('cash_custody.order_collection_own','finance','order_collection','create','own'),
 ('cash_custody.order_expense','finance','order_expense','create','all'),
 ('cash_custody.order_expense_own','finance','order_expense','create','own'),
 ('cash_custody.worker_payment_out','finance','worker_payment_out','create','all'),
 ('cash_custody.worker_payment_out_own','finance','worker_payment_out','create','own')
ON CONFLICT(code) DO NOTHING;

-- Generic cash inflow/outflow is an explicit privilege, not a default worker capability.
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id
  AND r.code='worker' AND p.code='cash_custody.create_own';

-- Administrative and finance roles can perform the specialized actions across employees.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','finance','accountant')
  AND p.code IN ('cash_custody.order_collection','cash_custody.order_expense','cash_custody.worker_payment_out')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1024_custody_action_permissions')
ON CONFLICT(version) DO NOTHING;
