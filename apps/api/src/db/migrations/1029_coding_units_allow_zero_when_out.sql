-- A fully delivered coding unit must retain its audit row while exposing zero remaining pieces.
-- Active units must always have a positive quantity; only terminal states may have zero.
ALTER TABLE coding_units
  DROP CONSTRAINT IF EXISTS coding_units_quantity_check;

ALTER TABLE coding_units
  ADD CONSTRAINT coding_units_quantity_check
  CHECK (quantity >= 0 AND (quantity > 0 OR status IN ('OUT','DELIVERED','CANCELLED')));

INSERT INTO schema_migrations(version)
VALUES ('1029_coding_units_allow_zero_when_out')
ON CONFLICT(version) DO NOTHING;
