ALTER TABLE rates ALTER COLUMN rate_group_id DROP NOT NULL;
INSERT INTO schema_migrations(version) VALUES('008_rate_group_nullable') ON CONFLICT(version) DO NOTHING;
