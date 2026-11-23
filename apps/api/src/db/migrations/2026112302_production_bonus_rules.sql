-- Automatic count-based production bonus rules. Scope is a column so other windows (day, week, order) can be added later;
-- only PER_RECORD (one production record reaching the quantity) is implemented.
CREATE TABLE IF NOT EXISTS production_bonus_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
  stage_id UUID NOT NULL REFERENCES stages(id),
  product_id UUID REFERENCES products(id),
  scope TEXT NOT NULL DEFAULT 'PER_RECORD' CHECK (scope IN ('PER_RECORD')),
  min_quantity NUMERIC(18,4) NOT NULL CHECK (min_quantity > 0),
  bonus_amount NUMERIC(18,4) NOT NULL CHECK (bonus_amount > 0),
  description TEXT NOT NULL CHECK (length(btrim(description)) >= 2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_production_bonus_rules_stage ON production_bonus_rules(stage_id) WHERE is_active;

-- Marks an adjustment that was created by a rule. It stays an ordinary adjustment: editable and deletable.
ALTER TABLE employee_earnings_adjustments
  ADD COLUMN IF NOT EXISTS bonus_rule_id UUID REFERENCES production_bonus_rules(id) ON DELETE SET NULL;

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('production.bonus_rules.view','production','bonus_rule','view','all'),
 ('production.bonus_rules.manage','production','bonus_rule','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager') AND p.code IN ('production.bonus_rules.view','production.bonus_rules.manage')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('2026112302_production_bonus_rules') ON CONFLICT(version) DO NOTHING;
