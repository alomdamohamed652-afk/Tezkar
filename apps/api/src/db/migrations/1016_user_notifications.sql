CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('TASK_ASSIGNED','PRODUCTION_APPROVED','PAYMENT_REQUEST_APPROVED','PAYMENT_REQUEST_REJECTED','PAYMENT_PAID','SYSTEM')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 180),
  body TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
  href TEXT,
  entity_type TEXT,
  entity_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
  ON user_notifications(user_id, created_at DESC);
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations(version)
VALUES ('1016_user_notifications')
ON CONFLICT(version) DO NOTHING;
