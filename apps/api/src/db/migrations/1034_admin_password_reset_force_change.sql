ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO schema_migrations(version)
VALUES ('1034_admin_password_reset_force_change')
ON CONFLICT (version) DO NOTHING;
