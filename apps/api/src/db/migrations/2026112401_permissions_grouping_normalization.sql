-- Display grouping only: normalize the permissions.module column to the canonical
-- section set rendered by the settings page (no more repeated "وظائف أخرى" groups).
-- Permission codes, scope values and every role grant stay untouched, so effective
-- access is identical before and after this migration.
UPDATE permissions SET module='iam' WHERE code='audit.view';
UPDATE permissions SET module='master_data' WHERE code IN ('products.delete','product_categories.delete','products.view','products.create');
UPDATE permissions SET module='machine_production' WHERE code='machine_production.view';
UPDATE permissions SET module='earnings' WHERE code='earnings.administrative_settlement.create';
UPDATE permissions SET module='finance' WHERE code='admin.account_health.view';
UPDATE permissions SET module='custody' WHERE code IN ('custody.view','custody.view_own','custody.create','custody.settle','custody.transfer');
UPDATE permissions SET module='cash_custody' WHERE code IN (
 'cash_custody.view','cash_custody.view_own','cash_custody.create','cash_custody.create_own',
 'cash_custody.transfer','cash_custody.order_collection','cash_custody.order_collection_own',
 'cash_custody.order_expense','cash_custody.order_expense_own',
 'cash_custody.worker_payment_out','cash_custody.worker_payment_out_own'
);

INSERT INTO schema_migrations(version)
VALUES ('2026112401_permissions_grouping_normalization')
ON CONFLICT(version) DO NOTHING;
