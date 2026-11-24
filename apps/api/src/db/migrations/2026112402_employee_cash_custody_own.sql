-- Employee-role self-service custody: own ledger, own spending (OUT only) and
-- transfers out of the employee's own custody to other custody holders.
-- Funding (IN) stays finance-only by design. No other role's grants change.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('cash_custody.transfer_own','cash_custody','cash_custody','transfer','own')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='employee'
  AND p.code IN ('cash_custody.view_own','cash_custody.create_own','cash_custody.transfer_own')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('2026112402_employee_cash_custody_own')
ON CONFLICT(version) DO NOTHING;
