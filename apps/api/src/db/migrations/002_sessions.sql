CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions(user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_sessions_active
  ON user_sessions(token_hash)
  WHERE revoked_at IS NULL;

INSERT INTO schema_migrations(version)
VALUES ('002_sessions')
ON CONFLICT (version) DO NOTHING;
