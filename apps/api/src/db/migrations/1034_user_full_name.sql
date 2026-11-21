ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
UPDATE users u SET full_name=e.full_name
FROM employees e WHERE u.employee_id=e.id AND u.full_name IS NULL;
INSERT INTO schema_migrations(version)
VALUES ('1034_user_full_name')
ON CONFLICT(version) DO NOTHING;
