CREATE TABLE IF NOT EXISTS employee_production_closure_access (
  id SMALLINT PRIMARY KEY CHECK (id=1),
  password_hash TEXT NOT NULL,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
