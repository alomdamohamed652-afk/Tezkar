CREATE TABLE IF NOT EXISTS system_reset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE system_reset_events ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version)
VALUES ('1033_system_reset_events')
ON CONFLICT (version) DO NOTHING;
