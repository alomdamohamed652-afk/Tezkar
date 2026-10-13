-- Keep the requested gross earnings separate from the net cash actually handed to a worker.
ALTER TABLE worker_payments
  ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_repayment_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

UPDATE worker_payments
   SET gross_amount=amount
 WHERE gross_amount=0;

ALTER TABLE worker_payments
  DROP CONSTRAINT IF EXISTS worker_payments_gross_amount_check;
ALTER TABLE worker_payments
  ADD CONSTRAINT worker_payments_gross_amount_check
  CHECK (gross_amount >= amount AND advance_repayment_amount >= 0
         AND ROUND(gross_amount-amount,2)=ROUND(advance_repayment_amount,2));

ALTER TABLE employee_earnings_ledger
  ADD COLUMN IF NOT EXISTS worker_payment_id UUID REFERENCES worker_payments(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_ledger_worker_payment
  ON employee_earnings_ledger(worker_payment_id)
  WHERE worker_payment_id IS NOT NULL;

ALTER TABLE advance_repayments
  ADD COLUMN IF NOT EXISTS source_worker_payment_id UUID REFERENCES worker_payments(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_advance_repayments_source_worker_payment_advance
  ON advance_repayments(source_worker_payment_id,advance_id)
  WHERE source_worker_payment_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('1031_worker_payment_advance_offsets')
ON CONFLICT(version) DO NOTHING;
