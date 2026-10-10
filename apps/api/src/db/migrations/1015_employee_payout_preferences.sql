ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS instapay_handle TEXT,
  ADD COLUMN IF NOT EXISTS vodafone_cash_number TEXT,
  ADD COLUMN IF NOT EXISTS preferred_payment_method TEXT;

ALTER TABLE employees
  ADD CONSTRAINT employees_preferred_payment_method_check
  CHECK (preferred_payment_method IS NULL OR preferred_payment_method IN ('CASH','VODAFONE_CASH','INSTAPAY','BANK'));

INSERT INTO schema_migrations(version)
VALUES ('1015_employee_payout_preferences')
ON CONFLICT(version) DO NOTHING;
