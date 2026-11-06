ALTER TABLE delivery_permissions
  ADD COLUMN IF NOT EXISTS delivery_value NUMERIC(18,2) NULL
  CHECK (delivery_value IS NULL OR delivery_value >= 0);

INSERT INTO schema_migrations(version)
VALUES ('2026101502_delivery_optional_value')
ON CONFLICT(version) DO NOTHING;
