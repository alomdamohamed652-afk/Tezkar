-- Tezkar finance integrity: collision-safe revenue codes.
CREATE SEQUENCE IF NOT EXISTS revenue_code_seq START 1;

ALTER TABLE order_revenues
  ALTER COLUMN code SET DEFAULT ('REV-' || lpad(nextval('revenue_code_seq')::text,8,'0'));

INSERT INTO schema_migrations(version)
VALUES ('1001_finance_integrity')
ON CONFLICT(version) DO NOTHING;
