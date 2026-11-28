-- Managed laser scrap reasons and traceable reason snapshots.
CREATE TABLE IF NOT EXISTS laser_scrap_reasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,40}$'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_laser_scrap_reason_name
  ON laser_scrap_reasons(lower(trim(name)));
ALTER TABLE machine_productions
  ADD COLUMN IF NOT EXISTS scrap_reason_id UUID REFERENCES laser_scrap_reasons(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS scrap_reason_detail TEXT;

INSERT INTO laser_scrap_reasons(code,name,created_by,updated_by) VALUES
 ('MACHINE_SETUP','هالك إعداد الماكينة',NULL,NULL),
 ('MATERIAL_DEFECT','عيب في الخامة',NULL,NULL),
 ('DESIGN_SETUP_ERROR','خطأ في التصميم أو الإعداد',NULL,NULL),
 ('OTHER','أسباب أخرى',NULL,NULL)
ON CONFLICT(code) DO NOTHING;

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('machine_production.scrap_reasons.manage','machine_production','laser_scrap_reason','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','production_manager')
  AND p.code='machine_production.scrap_reasons.manage'
ON CONFLICT DO NOTHING;

ALTER TABLE laser_scrap_reasons ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version) VALUES ('2003_laser_scrap_reasons_export') ON CONFLICT(version) DO NOTHING;
