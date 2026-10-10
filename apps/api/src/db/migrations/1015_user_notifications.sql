CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (length(trim(notification_type)) BETWEEN 2 AND 60),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 180),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 500),
  entity_type TEXT,
  entity_id UUID,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications(recipient_user_id,created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient
  ON user_notifications(recipient_user_id,created_at DESC);
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations(version) VALUES ('1015_user_notifications')
ON CONFLICT(version) DO NOTHING;
