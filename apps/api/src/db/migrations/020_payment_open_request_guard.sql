CREATE UNIQUE INDEX IF NOT EXISTS uq_open_payment_request_per_employee
  ON payment_requests(employee_id)
  WHERE status IN ('PENDING','APPROVED');

INSERT INTO schema_migrations(version)
VALUES ('020_payment_open_request_guard')
ON CONFLICT (version) DO NOTHING;
