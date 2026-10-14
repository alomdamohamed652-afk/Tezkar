-- Give shift leaders the worker's existing self-service permissions plus the
-- operational screens needed to record worker/machine output and move stock.
INSERT INTO roles(code,name,is_system,is_active)
VALUES ('shift_leader','رئيس وردية',TRUE,TRUE)
ON CONFLICT(code) DO UPDATE
SET name=EXCLUDED.name,is_active=TRUE;

-- Keep all worker capabilities (own tasks, payroll, advances, earnings, etc.)
-- aligned without copying permissions that belong to administrative roles.
INSERT INTO role_permissions(role_id,permission_id)
SELECT leader.id,rp.permission_id
FROM roles leader
JOIN roles worker ON worker.code='worker'
JOIN role_permissions rp ON rp.role_id=worker.id
WHERE leader.code='shift_leader'
ON CONFLICT DO NOTHING;

-- Employee names/codes are needed in production forms. This lookup permission
-- does not grant access to the full employee directory or employee maintenance.
INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('employees.lookup','hr','employee','lookup','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'employees.lookup',
  'orders.view',
  'products.view',
  'shifts.view',
  'rates.view',
  'machines.view',
  'machine_production.view',
  'machine_production.create',
  'production.view',
  'production.create',
  'warehouse.view',
  'warehouse.move',
  'deliveries.view',
  'deliveries.create',
  'cartons.view',
  'cartons.manage'
)
WHERE r.code='shift_leader'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026101405_shift_leader_operational_permissions')
ON CONFLICT(version) DO NOTHING;
