-- Allow the explicitly gated, one-time trial reset to truncate the event table.
-- Ordinary UPDATE/DELETE/TRUNCATE attempts remain blocked by the append-only trigger.
CREATE OR REPLACE FUNCTION prevent_worker_payment_settlement_difference_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE'
     AND current_setting('tezkar.allow_trial_data_reset', TRUE) = 'on' THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'worker payment settlement difference events are append-only'
    USING ERRCODE = '55000';
END;
$$;

INSERT INTO schema_migrations(version)
VALUES ('2026111105_worker_payment_difference_reset_guard')
ON CONFLICT(version) DO NOTHING;
