ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bootstrap BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_complete_setup BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_bootstrap_setup
  ON users(is_bootstrap, must_complete_setup, is_active);

INSERT INTO schema_migrations(version)
VALUES ('004_bootstrap_setup')
ON CONFLICT (version) DO NOTHING;
