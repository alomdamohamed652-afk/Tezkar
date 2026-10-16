-- Treat a worker payment and an admin production settlement as the same gross-earnings
-- settlement source, preventing either flow from paying the same earnings twice.
ALTER TABLE employee_earnings_settlements
  ADD COLUMN IF NOT EXISTS worker_payment_id UUID REFERENCES worker_payments(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_earnings_settlements_worker_payment
  ON employee_earnings_settlements(worker_payment_id)
  WHERE worker_payment_id IS NOT NULL;

-- Ensure the payout permission exists and is administrative (the payroll payment endpoint requires all scope).
INSERT INTO permissions(code,module,entity,action,scope)
VALUES('payroll.pay','payroll','payroll','pay','all')
ON CONFLICT(code) DO UPDATE SET scope='all';

-- Grant payout to the same roles already authorized to approve payroll periods.
INSERT INTO role_permissions(role_id,permission_id)
SELECT approval_grant.role_id,payout_permission.id
FROM role_permissions approval_grant
JOIN permissions approval_permission ON approval_permission.id=approval_grant.permission_id
JOIN permissions payout_permission ON payout_permission.code='payroll.pay'
WHERE approval_permission.code='payroll.approve'
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('1032_worker_payment_settlement_link')
ON CONFLICT(version) DO NOTHING;
