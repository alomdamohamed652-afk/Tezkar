-- Tezkar v1.0: task management and fixed-salary payroll
CREATE SEQUENCE IF NOT EXISTS task_code_seq START 1;
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('TSK-' || lpad(nextval('task_code_seq')::text,7,'0')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 240),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED')),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  due_date DATE,
  created_by UUID NOT NULL REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  assigned_by UUID REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,employee_id)
);
CREATE TABLE IF NOT EXISTS task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status,due_date);
CREATE INDEX IF NOT EXISTS idx_task_assignees_employee ON task_assignees(employee_id,task_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id,created_at);

CREATE TABLE IF NOT EXISTS employee_salary_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  monthly_salary NUMERIC(18,2) NOT NULL CHECK(monthly_salary >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_profile_open
  ON employee_salary_profiles(employee_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_salary_profiles_effective
  ON employee_salary_profiles(employee_id,effective_from,effective_to);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month DATE NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','CLOSED')),
  generated_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES employees(id),
  salary_profile_id UUID REFERENCES employee_salary_profiles(id),
  accounting_expense_id UUID REFERENCES accounting_expenses(id),
  base_salary NUMERIC(18,2) NOT NULL CHECK(base_salary >= 0),
  bonus_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(bonus_amount >= 0),
  deduction_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(deduction_amount >= 0),
  net_amount NUMERIC(18,2) GENERATED ALWAYS AS (base_salary + bonus_amount - deduction_amount) STORED,
  status TEXT NOT NULL DEFAULT 'UNPAID' CHECK(status IN ('UNPAID','PARTIAL','PAID')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(period_id,employee_id),
  CHECK(base_salary + bonus_amount >= deduction_amount)
);
CREATE TABLE IF NOT EXISTS payroll_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_item_id UUID NOT NULL REFERENCES payroll_items(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL CHECK(amount > 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method TEXT,
  reference TEXT,
  notes TEXT,
  paid_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_items_period ON payroll_items(period_id,status);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_item ON payroll_payments(payroll_item_id,payment_date);

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('tasks.view','tasks','task','view','all'),
 ('tasks.view_own','tasks','task','view','own'),
 ('tasks.create','tasks','task','create','all'),
 ('tasks.edit','tasks','task','edit','all'),
 ('tasks.update_own','tasks','task','update','own'),
 ('tasks.comment','tasks','task_comment','create','own'),
 ('payroll.view','payroll','payroll','view','all'),
 ('payroll.manage','payroll','salary_profile','manage','all'),
 ('payroll.generate','payroll','payroll_period','generate','all'),
 ('payroll.approve','payroll','payroll_period','approve','all'),
 ('payroll.pay','payroll','payroll_payment','create','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager' AND p.code IN ('tasks.view','tasks.view_own','tasks.create','tasks.edit','tasks.update_own','tasks.comment','payroll.view','payroll.manage','payroll.generate','payroll.approve','payroll.pay')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('hr','supervisor','production_manager') AND p.code IN ('tasks.view','tasks.view_own','tasks.create','tasks.edit','tasks.update_own','tasks.comment')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('finance','accountant') AND p.code IN ('payroll.view','payroll.manage','payroll.generate','payroll.approve','payroll.pay')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='hr' AND p.code IN ('payroll.view','payroll.manage')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='worker' AND p.code IN ('tasks.view_own','tasks.update_own','tasks.comment')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='read_only' AND p.code='tasks.view_own'
ON CONFLICT DO NOTHING;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_salary_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payments ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version) VALUES ('1010_tasks_and_fixed_salary_payroll') ON CONFLICT(version) DO NOTHING;
