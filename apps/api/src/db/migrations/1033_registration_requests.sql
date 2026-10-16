CREATE TABLE IF NOT EXISTS registration_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  username TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_user_id UUID REFERENCES users(id),
  rejection_reason TEXT,
  request_ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_registration_requests_pending_username
  ON registration_requests (lower(username)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_registration_requests_status_created
  ON registration_requests(status, created_at DESC);
INSERT INTO schema_migrations(version)
VALUES ('1033_registration_requests')
ON CONFLICT(version) DO NOTHING;
