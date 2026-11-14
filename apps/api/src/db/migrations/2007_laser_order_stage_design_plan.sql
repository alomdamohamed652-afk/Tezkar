-- Explicit plan linking each order stage and machine to the laser design version it should run.
-- This is additive: historical orders and machine production are not rewritten.
CREATE TABLE IF NOT EXISTS laser_order_stage_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_stage_id UUID NOT NULL REFERENCES order_stages(id) ON DELETE RESTRICT,
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  design_version_id UUID NOT NULL REFERENCES laser_design_versions(id) ON DELETE RESTRICT,
  planned_quantity NUMERIC(18,3) CHECK (planned_quantity IS NULL OR planned_quantity > 0),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_by UUID REFERENCES users(id),
  deactivated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_laser_order_stage_designs_stage_machine_active
  ON laser_order_stage_designs(order_stage_id,machine_id,is_active);
CREATE INDEX IF NOT EXISTS idx_laser_order_stage_designs_version
  ON laser_order_stage_designs(design_version_id,is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_laser_order_stage_machine_design_active
  ON laser_order_stage_designs(order_stage_id,machine_id,design_version_id)
  WHERE is_active=TRUE;
ALTER TABLE laser_order_stage_designs ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('laser_designs.order_plan.view','laser_designs','laser_order_stage_design','view','all'),
 ('laser_designs.order_plan.manage','laser_designs','laser_order_stage_design','manage','all')
ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','production_manager')
  AND p.code IN ('laser_designs.order_plan.view','laser_designs.order_plan.manage')
ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES ('2007_laser_order_stage_design_plan') ON CONFLICT(version) DO NOTHING;
