-- API-level idempotency for machine-production submissions; legacy rows remain valid.
ALTER TABLE machine_productions
  ADD COLUMN IF NOT EXISTS idempotency_key UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

INSERT INTO schema_migrations(version) VALUES ('2005_laser_production_idempotency') ON CONFLICT(version) DO NOTHING;
