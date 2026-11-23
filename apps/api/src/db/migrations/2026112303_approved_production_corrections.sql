-- Stage 4: correcting entries for approved production edits + account-limited approvals.
-- permission_account_restrictions: when at least one row exists for a permission code, only the
-- listed accounts may exercise that permission (role permission is still required). An empty
-- list keeps the current role-based behavior, so this is opt-in and configurable.
CREATE TABLE IF NOT EXISTS permission_account_restrictions (
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (permission_code, user_id)
);

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
