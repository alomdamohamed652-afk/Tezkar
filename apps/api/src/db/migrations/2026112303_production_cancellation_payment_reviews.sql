-- When an approved production record is cancelled and it had been paid, the paid share is either reversed
-- automatically (all production of that payment cancelled) or queued here for an admin decision.
CREATE TABLE IF NOT EXISTS production_cancellation_payment_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_entry_id UUID NOT NULL REFERENCES production_entries(id),
  worker_payment_id UUID NOT NULL REFERENCES worker_payments(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  allocated_amount NUMERIC(18,4) NOT NULL,
  payment_gross_amount NUMERIC(18,4) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','AUTO_REVERSED','RESOLVED')),
  reason_code TEXT NOT NULL,
  detail TEXT,
  financial_reversal_id UUID REFERENCES financial_reversals(id),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (production_entry_id, worker_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_production_cancellation_reviews_open ON production_cancellation_payment_reviews(status) WHERE status='OPEN';

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('production.cancellation_reviews.view','production','cancellation_review','view','all'),
 ('production.cancellation_reviews.resolve','production','cancellation_review','resolve','all')
ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('admin','manager') AND p.code IN ('production.cancellation_reviews.view','production.cancellation_reviews.resolve')
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('2026112303_production_cancellation_payment_reviews') ON CONFLICT(version) DO NOTHING;
