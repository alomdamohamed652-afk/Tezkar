-- HR improvements: salary-based advance recovery and multiple payroll advances per period.
ALTER TABLE advance_requests
  ADD COLUMN IF NOT EXISTS salary_percentage NUMERIC(7,4);

ALTER TABLE advance_requests
  DROP CONSTRAINT IF EXISTS advance_requests_repayment_method_check;
ALTER TABLE advance_requests
  ADD CONSTRAINT advance_requests_repayment_method_check
  CHECK (repayment_method IN ('FIXED_INSTALLMENT','SALARY_PERCENTAGE','PRODUCTION_PERCENTAGE','CUSTOM'));

ALTER TABLE advance_requests
  DROP CONSTRAINT IF EXISTS advance_requests_salary_percentage_check;
ALTER TABLE advance_requests
  ADD CONSTRAINT advance_requests_salary_percentage_check
  CHECK (salary_percentage IS NULL OR (salary_percentage > 0 AND salary_percentage <= 100));

ALTER TABLE advance_repayments
  DROP CONSTRAINT IF EXISTS advance_repayments_repayment_type_check;
ALTER TABLE advance_repayments
  ADD CONSTRAINT advance_repayments_repayment_type_check
  CHECK (repayment_type IN ('FIXED_INSTALLMENT','SALARY_PERCENTAGE','PRODUCTION_PERCENTAGE','CUSTOM'));

ALTER TABLE payroll_advance_deductions
  DROP CONSTRAINT IF EXISTS payroll_advance_deductions_repayment_type_check;
ALTER TABLE payroll_advance_deductions
  ADD CONSTRAINT payroll_advance_deductions_repayment_type_check
  CHECK (repayment_type IN ('FIXED_INSTALLMENT','SALARY_PERCENTAGE'));

-- A payroll item may repay more than one advance. Idempotency is per advance and payroll item.
DROP INDEX IF EXISTS uq_advance_repayments_source_payroll_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_source_payroll_advance
  ON advance_repayments(source_payroll_item_id,advance_id)
  WHERE source_payroll_item_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1028_hr_shifts_payroll_advances')
ON CONFLICT(version) DO NOTHING;
