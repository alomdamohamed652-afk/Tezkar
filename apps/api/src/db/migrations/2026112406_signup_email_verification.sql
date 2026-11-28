-- التحقق من البريد الإلكتروني عند إنشاء الحساب: عمود البريد في طلبات التسجيل
-- وجدول أكواد تحقق للزائرين (إضافي بالكامل، يقبل NULL، لا يغيّر بيانات قائمة)
ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS email TEXT;

CREATE TABLE IF NOT EXISTS signup_email_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  created_ip TEXT,
  created_user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_email_otps_email
  ON signup_email_otps (lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_email_otps_expiry
  ON signup_email_otps (expires_at) WHERE consumed_at IS NULL;
