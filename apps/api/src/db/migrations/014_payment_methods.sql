CREATE TABLE IF NOT EXISTS payment_methods (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO payment_methods(code,name,sort_order) VALUES
 ('CASH','نقدي',10),
 ('VODAFONE_CASH','فودافون كاش',20),
 ('INSTAPAY','إنستا باي',30),
 ('BANK','تحويل بنكي',40)
ON CONFLICT(code) DO NOTHING;

ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_method_check;
ALTER TABLE worker_payments DROP CONSTRAINT IF EXISTS worker_payments_method_check;

ALTER TABLE payment_requests
  ADD CONSTRAINT payment_requests_method_fk FOREIGN KEY(method) REFERENCES payment_methods(code);

ALTER TABLE worker_payments
  ADD CONSTRAINT worker_payments_method_fk FOREIGN KEY(method) REFERENCES payment_methods(code);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('payment_methods.manage','payroll','payment_method','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='payment_methods.manage'
WHERE r.code IN ('manager','finance','accountant')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('014_payment_methods')
ON CONFLICT(version) DO NOTHING;
