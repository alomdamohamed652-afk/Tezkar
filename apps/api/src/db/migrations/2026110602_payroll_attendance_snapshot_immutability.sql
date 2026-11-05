-- Approved payroll attendance snapshots and their calculation policy are immutable.
CREATE OR REPLACE FUNCTION prevent_approved_payroll_attendance_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id
      WHERE i.id=NEW.payroll_item_id AND p.status IN ('APPROVED','CLOSED')
    ) THEN
      RAISE EXCEPTION 'Approved payroll attendance snapshots are immutable'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id
      WHERE i.id=OLD.payroll_item_id AND p.status IN ('APPROVED','CLOSED')
    ) THEN
      RAISE EXCEPTION 'Approved payroll attendance snapshots are immutable'
        USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  ELSE
    IF EXISTS (
      SELECT 1 FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id
      WHERE i.id IN (OLD.payroll_item_id,NEW.payroll_item_id)
        AND p.status IN ('APPROVED','CLOSED')
    ) THEN
      RAISE EXCEPTION 'Approved payroll attendance snapshots are immutable'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS payroll_attendance_snapshots_immutable ON payroll_attendance_snapshots;
CREATE TRIGGER payroll_attendance_snapshots_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_attendance_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_approved_payroll_attendance_snapshot_mutation();

DROP TRIGGER IF EXISTS payroll_attendance_calculations_immutable ON payroll_attendance_calculations;
CREATE TRIGGER payroll_attendance_calculations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_attendance_calculations
  FOR EACH ROW EXECUTE FUNCTION prevent_approved_payroll_attendance_snapshot_mutation();

INSERT INTO schema_migrations(version)
VALUES ('2026110602_payroll_attendance_snapshot_immutability')
ON CONFLICT(version) DO NOTHING;
