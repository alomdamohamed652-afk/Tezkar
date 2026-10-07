CREATE UNIQUE INDEX IF NOT EXISTS uq_open_advance_per_employee
  ON advance_requests(employee_id)
  WHERE status IN ('PENDING','APPROVED');

INSERT INTO schema_migrations(version)
VALUES ('019_advance_open_request_guard')
ON CONFLICT (version) DO NOTHING;
