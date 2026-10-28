-- Extend laser design versions into production records without rewriting legacy rows.
ALTER TABLE laser_design_versions
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE RESTRICT;

ALTER TABLE machine_productions
  ADD COLUMN IF NOT EXISTS laser_design_version_id UUID REFERENCES laser_design_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cycles_count INTEGER CHECK (cycles_count IS NULL OR cycles_count > 0),
  ADD COLUMN IF NOT EXISTS expected_quantity NUMERIC(18,3) CHECK (expected_quantity IS NULL OR expected_quantity >= 0),
  ADD COLUMN IF NOT EXISTS good_quantity NUMERIC(18,3) CHECK (good_quantity IS NULL OR good_quantity >= 0),
  ADD COLUMN IF NOT EXISTS scrap_quantity NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (scrap_quantity >= 0),
  ADD COLUMN IF NOT EXISTS scrap_reason TEXT;

ALTER TABLE machine_productions
  ADD CONSTRAINT chk_machine_production_laser_quantities CHECK (
    laser_design_version_id IS NULL OR (
      cycles_count IS NOT NULL AND expected_quantity IS NOT NULL AND good_quantity IS NOT NULL
      AND quantity = good_quantity AND good_quantity + scrap_quantity <= expected_quantity
    )
  );

CREATE INDEX IF NOT EXISTS idx_machine_productions_laser_version_date
  ON machine_productions(laser_design_version_id,work_date) WHERE laser_design_version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS machine_production_operators (
  machine_production_id UUID NOT NULL REFERENCES machine_productions(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  operator_role TEXT NOT NULL CHECK (operator_role IN ('PRIMARY','TEAM')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(machine_production_id,employee_id)
);
CREATE INDEX IF NOT EXISTS idx_machine_production_operators_employee
  ON machine_production_operators(employee_id,machine_production_id);
ALTER TABLE machine_production_operators ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('machine_production.reports.view','machine_production','machine_production_report','view','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','production_manager')
  AND p.code='machine_production.reports.view'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('2001_laser_production_runs') ON CONFLICT(version) DO NOTHING;
