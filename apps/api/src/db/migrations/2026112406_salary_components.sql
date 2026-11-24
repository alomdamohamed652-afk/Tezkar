-- مفردات المرتب الثابتة لكل موظف: بدلات وخصومات متكررة تُطبق تلقائيًا عند توليد مسير الرواتب.
-- إضافي بالكامل: جدول جديد وعمود جديد يقبل NULL، لا يغيّر أي بيانات قائمة.
CREATE TABLE IF NOT EXISTS employee_salary_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  line_type TEXT NOT NULL CHECK (line_type IN ('BONUS','DEDUCTION')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 240),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_salary_components_employee
  ON employee_salary_components(employee_id,is_active);

-- يربط بند المسير المولّد تلقائيًا بالمفردة التي جاء منها، حتى يمكن إعادة توليده
-- عند إعادة حساب المسودة دون لمس البنود اليدوية.
ALTER TABLE payroll_adjustment_lines
  ADD COLUMN IF NOT EXISTS salary_component_id UUID REFERENCES employee_salary_components(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_adjustment_lines_salary_component
  ON payroll_adjustment_lines(salary_component_id) WHERE salary_component_id IS NOT NULL;
