ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bootstrap BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_complete_setup BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO permissions (code,module,entity,action,scope) VALUES
('departments.view','master_data','department','view','all'),
('departments.create','master_data','department','create','all'),
('job_titles.view','master_data','job_title','view','all'),
('job_titles.create','master_data','job_title','create','all'),
('users.create','iam','user','create','all'),
('users.edit','iam','user','edit','all'),
('rates.view','production','rate','view','all'),
('rates.create','production','rate','create','all'),
('rates.edit','production','rate','edit','all'),
('shifts.view','production','shift','view','all'),
('shifts.create','production','shift','create','all'),
('shifts.assign_leader','production','shift','assign_leader','all'),
('products.view','products','product','view','all'),
('products.create','products','product','create','all'),
('stages.create','production','stage','create','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('006_bootstrap_and_permissions') ON CONFLICT (version) DO NOTHING;
