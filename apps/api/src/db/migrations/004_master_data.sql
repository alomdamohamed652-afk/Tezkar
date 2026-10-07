CREATE SEQUENCE IF NOT EXISTS rate_group_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS shift_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS unit_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS stage_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS wage_type_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS product_category_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS product_code_seq START 1;

CREATE TABLE IF NOT EXISTS rate_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('RG-' || lpad(nextval('rate_group_code_seq')::TEXT, 4, '0')),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('UNT-' || lpad(nextval('unit_code_seq')::TEXT, 4, '0')),
  name TEXT NOT NULL,
  symbol TEXT,
  decimal_places INTEGER NOT NULL DEFAULT 0 CHECK (decimal_places BETWEEN 0 AND 6),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('STG-' || lpad(nextval('stage_code_seq')::TEXT, 4, '0')),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wage_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('WGT-' || lpad(nextval('wage_type_code_seq')::TEXT, 4, '0')),
  name TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('PER_PIECE','PER_1000','PER_HOUR','PER_DAY','PERCENTAGE')),
  percentage_base TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('SFT-' || lpad(nextval('shift_code_seq')::TEXT, 4, '0')),
  name TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  crosses_midnight BOOLEAN NOT NULL DEFAULT FALSE,
  rate_group_id UUID NOT NULL REFERENCES rate_groups(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shift_leaders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES shifts(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  assignment_type TEXT NOT NULL DEFAULT 'primary',
  starts_on DATE,
  ends_on DATE,
  assigned_by UUID REFERENCES users(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shift_leader_dates_chk CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('CAT-' || lpad(nextval('product_category_code_seq')::TEXT, 4, '0')),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shifts_rate_group ON shifts(rate_group_id);
CREATE INDEX IF NOT EXISTS idx_shift_leaders_shift ON shift_leaders(shift_id, is_active);
CREATE INDEX IF NOT EXISTS idx_shift_leaders_employee ON shift_leaders(employee_id, is_active);

INSERT INTO schema_migrations(version) VALUES ('004_master_data') ON CONFLICT (version) DO NOTHING;
