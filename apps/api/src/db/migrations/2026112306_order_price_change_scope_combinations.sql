-- Allow any combination of price-change scope groups:
-- new production, approved-unpaid, approved-paid (retroactive).
-- Existing values keep their meaning; the four new values cover the
-- combinations that were not expressible before.
ALTER TABLE order_price_changes DROP CONSTRAINT IF EXISTS order_price_changes_scope_check;
ALTER TABLE order_price_changes
  ADD CONSTRAINT order_price_changes_scope_check
  CHECK (scope IN ('NEW_ONLY','UNPAID_ONLY','ALL','NEW_AND_PAID','PAST_UNPAID_ONLY','PAST_PAID_ONLY','PAST_ALL'));
