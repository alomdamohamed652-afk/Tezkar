-- Manual machine operation sessions, downtime, and effective-dated production targets.
CREATE TABLE IF NOT EXISTS laser_machine_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  design_version_id UUID REFERENCES laser_design_versions(id) ON DELETE RESTRICT,
  shift_id UUID REFERENCES shifts(id) ON DELETE RESTRICT,
  period_type TEXT NOT NULL CHECK (period_type IN ('DAY','MONTH','SHIFT')),
  effective_from DATE NOT NULL,
  effective_to DATE NOT NULL,
  target_quantity NUMERIC(18,3) NOT NULL CHECK (target_quantity > 0),
  target_cycles INTEGER CHECK (target_cycles IS NULL OR target_cycles > 0),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to >= effective_from),
  CHECK (period_type <> 'SHIFT' OR shift_id IS NOT NULL),
  CHECK (period_type <> 'DAY' OR effective_to = effective_from),
  CHECK (period_type <> 'SHIFT' OR effective_to = effective_from),
  CHECK (period_type <> 'MONTH' OR (date_trunc('month',effective_from)::date = effective_from AND effective_to = (date_trunc('month',effective_from) + interval '1 month' - interval '1 day')::date))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_laser_machine_target_active
  ON laser_machine_targets(machine_id,COALESCE(design_version_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(shift_id,'00000000-0000-0000-0000-000000000000'::uuid),period_type,effective_from)
  WHERE is_active=TRUE;
CREATE INDEX IF NOT EXISTS idx_laser_machine_targets_period
  ON laser_machine_targets(machine_id,effective_from,effective_to,is_active);

CREATE TABLE IF NOT EXISTS laser_machine_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  design_version_id UUID NOT NULL REFERENCES laser_design_versions(id) ON DELETE RESTRICT,
  operator_employee_id UUID REFERENCES employees(id) ON DELETE RESTRICT,
  shift_id UUID REFERENCES shifts(id) ON DELETE RESTRICT,
  target_id UUID REFERENCES laser_machine_targets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','STOPPED','COMPLETED','CANCELLED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  started_by UUID NOT NULL REFERENCES users(id),
  ended_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((status='RUNNING' AND ended_at IS NULL) OR (status<>'RUNNING' AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_laser_machine_one_running_session
  ON laser_machine_sessions(machine_id) WHERE status='RUNNING';
CREATE INDEX IF NOT EXISTS idx_laser_machine_sessions_started
  ON laser_machine_sessions(machine_id,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_laser_machine_sessions_design_started
  ON laser_machine_sessions(design_version_id,started_at DESC);

CREATE TABLE IF NOT EXISTS laser_machine_downtime_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  session_id UUID REFERENCES laser_machine_sessions(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 2 AND 500),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  ended_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_laser_machine_open_downtime
  ON laser_machine_downtime_events(machine_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_laser_machine_downtime_machine_time
  ON laser_machine_downtime_events(machine_id,started_at DESC);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('machine_production.live.view','machine_production','machine_operation_session','view','all'),
 ('machine_production.sessions.manage','machine_production','machine_operation_session','manage','all'),
 ('machine_production.targets.manage','machine_production','machine_production_target','manage','all'),
 ('machine_production.downtime.manage','machine_production','machine_downtime','manage','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager','production_manager')
  AND p.code IN ('machine_production.live.view','machine_production.sessions.manage','machine_production.targets.manage','machine_production.downtime.manage')
ON CONFLICT DO NOTHING;

ALTER TABLE laser_machine_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE laser_machine_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE laser_machine_downtime_events ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version) VALUES ('2002_laser_machine_sessions_targets') ON CONFLICT(version) DO NOTHING;
