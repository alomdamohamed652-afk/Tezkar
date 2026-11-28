-- Support append-only reversal of non-cash zero-net payroll settlements.
-- A reversed payroll item remains approved historically but is no longer marked settled.
ALTER TABLE payroll_items
  DROP CONSTRAINT IF EXISTS payroll_items_status_check;

ALTER TABLE payroll_items
  ADD CONSTRAINT payroll_items_status_check
  CHECK (status IN ('UNPAID','PARTIAL','PAID','REVERSED'));

ALTER TABLE financial_reversal_lines
  DROP CONSTRAINT IF EXISTS financial_reversal_lines_source_type_check;

ALTER TABLE financial_reversal_lines
  ADD CONSTRAINT financial_reversal_lines_source_type_check
  CHECK (source_type IN ('PAYROLL_PAYMENT','ADVANCE_REPAYMENT','ZERO_NET_PAYROLL_SETTLEMENT'));

INSERT INTO schema_migrations(version)
VALUES ('2026110608_zero_net_payroll_reversals')
ON CONFLICT(version) DO NOTHING;
