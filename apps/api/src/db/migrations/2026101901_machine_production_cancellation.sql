ALTER TABLE machine_productions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','CANCELLED')),
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_machine_productions_status_date
  ON machine_productions(status, work_date DESC, created_at DESC);

INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('machine_production.cancel','production','machine_production','cancel','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.code IN ('manager','production_manager')
   AND p.code='machine_production.cancel'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026101901_machine_production_cancellation')
ON CONFLICT (version) DO NOTHING;
