CREATE SEQUENCE IF NOT EXISTS payment_request_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS worker_payment_code_seq START 1;

CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('PAY-' || lpad(nextval('payment_request_code_seq')::TEXT, 8, '0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('CASH','VODAFONE_CASH','INSTAPAY','BANK')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','PAID')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by UUID NOT NULL REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  paid_payment_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_request_review_chk CHECK (
    status NOT IN ('APPROVED','REJECTED','PAID') OR reviewed_by IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS worker_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('WPM-' || lpad(nextval('worker_payment_code_seq')::TEXT, 8, '0')),
  employee_id UUID NOT NULL REFERENCES employees(id),
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('CASH','VODAFONE_CASH','INSTAPAY','BANK')),
  payment_request_id UUID UNIQUE REFERENCES payment_requests(id),
  paid_by UUID NOT NULL REFERENCES users(id),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payment_requests
  ADD CONSTRAINT payment_request_paid_fk
  FOREIGN KEY (paid_payment_id) REFERENCES worker_payments(id);

CREATE INDEX IF NOT EXISTS idx_payment_requests_employee_status
  ON payment_requests(employee_id,status,requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_payments_employee_date
  ON worker_payments(employee_id,paid_at DESC);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
('payment_requests.view','payroll','payment_request','view','all'),
('payment_requests.create','payroll','payment_request','create','own'),
('payment_requests.approve','payroll','payment_request','approve','all'),
('payment_requests.reject','payroll','payment_request','reject','all'),
('worker_payments.view','payroll','worker_payment','view','all'),
('worker_payments.pay','payroll','worker_payment','pay','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='finance'
  AND p.code IN ('payment_requests.view','payment_requests.approve','payment_requests.reject','worker_payments.view','worker_payments.pay')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='worker'
  AND p.code IN ('payment_requests.view','payment_requests.create')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('008_payments') ON CONFLICT (version) DO NOTHING;
