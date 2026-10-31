-- Laser design catalog and machine compatibility foundation.
-- Existing machine production rows and stock history are intentionally untouched.

CREATE SEQUENCE IF NOT EXISTS laser_design_code_seq START 1;

CREATE TABLE IF NOT EXISTS laser_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('LD-' || lpad(nextval('laser_design_code_seq')::text, 6, '0')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  thumbnail_url TEXT,
  file_reference TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS laser_design_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id UUID NOT NULL REFERENCES laser_designs(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  material_type TEXT NOT NULL CHECK (length(trim(material_type)) BETWEEN 1 AND 80),
  material_thickness_mm NUMERIC(10,3) CHECK (material_thickness_mm IS NULL OR material_thickness_mm >= 0),
  width_mm NUMERIC(12,3) CHECK (width_mm IS NULL OR width_mm > 0),
  height_mm NUMERIC(12,3) CHECK (height_mm IS NULL OR height_mm > 0),
  unit_label TEXT NOT NULL DEFAULT 'قطعة' CHECK (length(trim(unit_label)) BETWEEN 1 AND 40),
  pieces_per_cycle INTEGER NOT NULL CHECK (pieces_per_cycle > 0),
  standard_cycle_seconds NUMERIC(12,2) CHECK (standard_cycle_seconds IS NULL OR standard_cycle_seconds > 0),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (design_id, version_no)
);

CREATE TABLE IF NOT EXISTS laser_machine_design_compatibility (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  design_version_id UUID NOT NULL REFERENCES laser_design_versions(id) ON DELETE RESTRICT,
  settings_notes TEXT,
  pieces_per_cycle_override INTEGER CHECK (pieces_per_cycle_override IS NULL OR pieces_per_cycle_override > 0),
  standard_cycle_seconds_override NUMERIC(12,2) CHECK (standard_cycle_seconds_override IS NULL OR standard_cycle_seconds_override > 0),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_laser_designs_status_name ON laser_designs(status, name);
CREATE INDEX IF NOT EXISTS idx_laser_design_versions_design_status ON laser_design_versions(design_id, status, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_laser_machine_compatibility_machine_active ON laser_machine_design_compatibility(machine_id, is_active, effective_from);
CREATE INDEX IF NOT EXISTS idx_laser_machine_compatibility_version ON laser_machine_design_compatibility(design_version_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_laser_machine_design_active ON laser_machine_design_compatibility(machine_id, design_version_id) WHERE is_active=TRUE;

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('laser_designs.view','laser_designs','laser_design','view','all'),
 ('laser_designs.manage','laser_designs','laser_design','manage','all'),
 ('laser_designs.compatibility.manage','laser_designs','machine_design_compatibility','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','production_manager')
  AND p.code IN ('laser_designs.view','laser_designs.manage','laser_designs.compatibility.manage')
ON CONFLICT DO NOTHING;

ALTER TABLE laser_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE laser_design_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE laser_machine_design_compatibility ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version) VALUES ('2000_laser_design_library') ON CONFLICT(version) DO NOTHING;
