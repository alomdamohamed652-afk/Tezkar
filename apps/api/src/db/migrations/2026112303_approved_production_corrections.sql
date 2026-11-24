-- Stage 4: correcting entries for approved production edits.
-- Immutable before/after record for edits applied to APPROVED production entries.
CREATE TABLE IF NOT EXISTS production_entry_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_entry_id uuid NOT NULL REFERENCES production_entries(id),
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL,
  earning_delta numeric(14,2) NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (length(trim(reason)) >= 2),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_entry_corrections_entry_idx
  ON production_entry_corrections(production_entry_id, created_at DESC);

INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('production.edit_approved','production','entry','edit_approved','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin') AND p.code='production.edit_approved'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026112303_approved_production_corrections')
ON CONFLICT(version) DO NOTHING;
