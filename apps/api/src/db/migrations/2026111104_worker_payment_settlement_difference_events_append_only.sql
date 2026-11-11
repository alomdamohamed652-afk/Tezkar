-- Difference events are an immutable audit ledger. Corrections are represented
-- by new reversal events; the event history is never edited or deleted.
CREATE OR REPLACE FUNCTION prevent_worker_payment_settlement_difference_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'worker payment settlement difference events are append-only'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS worker_payment_settlement_difference_events_immutable
  ON worker_payment_settlement_difference_events;

CREATE TRIGGER worker_payment_settlement_difference_events_immutable
BEFORE UPDATE OR DELETE ON worker_payment_settlement_difference_events
FOR EACH ROW
EXECUTE FUNCTION prevent_worker_payment_settlement_difference_event_mutation();

INSERT INTO schema_migrations(version)
VALUES ('2026111104_worker_payment_settlement_difference_events_append_only')
ON CONFLICT(version) DO NOTHING;
