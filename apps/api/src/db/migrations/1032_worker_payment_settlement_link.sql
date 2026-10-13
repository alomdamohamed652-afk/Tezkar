-- Treat a worker payment and an admin production settlement as the same gross-earnings
-- settlement source, preventing either flow from paying the same earnings twice.
ALTER TABLE employee_earnings_settlements
  ADD COLUMN IF NOT EXISTS worker_payment_id UUID REFERENCES worker_payments(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_settlements_worker_payment
  ON employee_earnings_settlements(worker_payment_id)
  WHERE worker_payment_id IS NOT NULL;

-- Payroll disbursement is an administrative action, not an employee self-service action.
UPDATE permissions SET scope='all' WHERE code='payroll.pay';

INSERT INTO schema_migrations(version)
VALUES ('1032_worker_payment_settlement_link')
ON CONFLICT(version) DO NOTHING;
