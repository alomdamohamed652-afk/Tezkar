-- Allow price changes without a written reason (reason becomes optional).
ALTER TABLE order_price_changes DROP CONSTRAINT IF EXISTS order_price_changes_reason_check;
ALTER TABLE order_price_changes ALTER COLUMN reason DROP NOT NULL;
