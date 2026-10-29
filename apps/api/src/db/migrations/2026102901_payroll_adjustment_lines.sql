-- Named payroll earning/deduction lines. Legacy aggregates are preserved as explicit opening lines.
CREATE TABLE IF NOT EXISTS payroll_adjustment_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_item_id UUID NOT NULL REFERENCES payroll_items(id) ON DELETE RESTRICT,
  line_type TEXT NOT NULL CHECK (line_type IN ('BONUS','DEDUCTION')),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 2 AND 240),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustment_lines_item
  ON payroll_adjustment_lines(payroll_item_id,line_type,created_at,id);

-- Convert existing totals into named opening lines, without changing net pay.
INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,notes,created_by)
SELECT i.id,'BONUS','مكافآت/بونصات سابقة غير مفصلة',i.bonus_amount,
       'تم ترحيل القيمة القديمة كما هي للحفاظ على صافي المرتب.',p.generated_by
FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id
WHERE i.bonus_amount > 0
  AND NOT EXISTS (SELECT 1 FROM payroll_adjustment_lines l WHERE l.payroll_item_id=i.id AND l.line_type='BONUS');

INSERT INTO payroll_adjustment_lines(payroll_item_id,line_type,description,amount,notes,created_by)
SELECT i.id,'DEDUCTION','خصومات سابقة غير مفصلة',i.deduction_amount,
       'تم ترحيل القيمة القديمة كما هي للحفاظ على صافي المرتب.',p.generated_by
FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id
WHERE i.deduction_amount > 0
  AND NOT EXISTS (SELECT 1 FROM payroll_adjustment_lines l WHERE l.payroll_item_id=i.id AND l.line_type='DEDUCTION');

INSERT INTO schema_migrations(version) VALUES ('2026102901_payroll_adjustment_lines')
ON CONFLICT(version) DO NOTHING;
