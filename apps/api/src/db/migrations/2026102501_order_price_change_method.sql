ALTER TABLE order_price_changes
  ADD COLUMN IF NOT EXISTS new_rate_method TEXT;

ALTER TABLE order_price_changes
  DROP CONSTRAINT IF EXISTS order_price_changes_new_rate_method_check;

ALTER TABLE order_price_changes
  ADD CONSTRAINT order_price_changes_new_rate_method_check
  CHECK (new_rate_method IS NULL OR new_rate_method IN ('PER_PIECE','PER_1000','PER_HOUR','PER_DAY','PERCENTAGE'));
