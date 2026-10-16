-- Existing installations may already have delivery_value as NOT NULL.
-- ADD COLUMN IF NOT EXISTS does not relax that constraint, so explicitly allow
-- delivery permissions without a monetary amount.
ALTER TABLE delivery_permissions
  ADD COLUMN IF NOT EXISTS delivery_value NUMERIC(18,2);

ALTER TABLE delivery_permissions
  ALTER COLUMN delivery_value DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'delivery_permissions'::regclass
      AND conname = 'delivery_permissions_delivery_value_nonnegative'
  ) THEN
    ALTER TABLE delivery_permissions
      ADD CONSTRAINT delivery_permissions_delivery_value_nonnegative
      CHECK (delivery_value IS NULL OR delivery_value >= 0);
  END IF;
END $$;

INSERT INTO schema_migrations(version)
VALUES ('2026101601_delivery_value_nullable_existing_db')
ON CONFLICT(version) DO NOTHING;
