CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 2000),
  entity_type text,
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_notifications_user_unread_idx
  ON user_notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx
  ON user_notifications(user_id, created_at DESC);

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version)
VALUES ('1027_user_notifications')
ON CONFLICT (version) DO NOTHING;
