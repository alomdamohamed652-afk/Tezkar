ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- Prevent duplicate account phone numbers while allowing legacy accounts without one.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_normalized_unique
ON users (RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10))
WHERE phone IS NOT NULL
  AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10;

-- New pending requests must have a phone number; old pending rows are preserved
-- so the administrator can still review requests created before this change.
CREATE UNIQUE INDEX IF NOT EXISTS registration_requests_pending_phone_unique
ON registration_requests (RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10))
WHERE status = 'pending'
  AND phone IS NOT NULL
  AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10;
