-- Tezkar v1.0.1: correct advance creation scope and model lost custody quantities.
-- The worker grant for advances.create was removed by migration 026; administrative
-- users need this permission at all-scope for the API's create guard to work.
UPDATE permissions SET scope='all' WHERE code='advances.create';

ALTER TABLE custody_settlements
  ADD COLUMN IF NOT EXISTS lost_quantity NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (lost_quantity >= 0);

ALTER TABLE custody_settlements
  DROP CONSTRAINT IF EXISTS custody_settlements_returned_quantity_check;

ALTER TABLE custody_settlements
  ADD CONSTRAINT custody_settlements_returned_quantity_check
    CHECK (returned_quantity >= 0);

INSERT INTO schema_migrations(version)
VALUES ('1011_custody_loss_and_advance_scope')
ON CONFLICT(version) DO NOTHING;
