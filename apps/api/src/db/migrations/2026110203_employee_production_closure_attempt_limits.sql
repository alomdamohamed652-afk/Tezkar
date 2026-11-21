CREATE TABLE IF NOT EXISTS employee_production_closure_access_attempts (
  ip_address TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_production_closure_access_attempts_updated_idx
  ON employee_production_closure_access_attempts(updated_at);
