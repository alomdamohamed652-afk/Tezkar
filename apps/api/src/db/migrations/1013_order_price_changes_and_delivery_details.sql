-- Auditable order-stage price changes and richer delivery note details.
CREATE SEQUENCE IF NOT EXISTS order_price_change_code_seq START 1;

CREATE TABLE IF NOT EXISTS order_price_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE DEFAULT ('OPC-' || lpad(nextval('order_price_change_code_seq')::text,7,'0')),
  order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE RESTRICT,
  order_stage_id UUID NOT NULL REFERENCES order_stages(id) ON DELETE RESTRICT,
  previous_rate NUMERIC(18,4),
  new_rate NUMERIC(18,4) NOT NULL CHECK (new_rate >= 0),
  scope TEXT NOT NULL CHECK (scope IN ('NEW_ONLY','UNPAID_ONLY','ALL')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 2 AND 500),
  affected_entries INTEGER NOT NULL DEFAULT 0 CHECK (affected_entries >= 0),
  total_delta NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_price_change_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_change_id UUID NOT NULL REFERENCES order_price_changes(id) ON DELETE RESTRICT,
  production_entry_id UUID NOT NULL REFERENCES production_entries(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  previous_earning NUMERIC(18,2) NOT NULL,
  revised_earning NUMERIC(18,2) NOT NULL,
  delta_amount NUMERIC(18,2) NOT NULL,
  ledger_adjustment BOOLEAN NOT NULL DEFAULT FALSE,
  applied_rate NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(price_change_id, production_entry_id)
);
ALTER TABLE order_price_change_items ADD COLUMN IF NOT EXISTS ledger_adjustment BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_order_price_changes_order ON order_price_changes(order_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_price_change_items_entry ON order_price_change_items(production_entry_id,created_at DESC);

ALTER TABLE delivery_permissions
  ADD COLUMN IF NOT EXISTS total_weight NUMERIC(18,3),
  ADD COLUMN IF NOT EXISTS piece_count NUMERIC(18,3),
  ADD COLUMN IF NOT EXISTS sample_quantity NUMERIC(18,3),
  ADD COLUMN IF NOT EXISTS details TEXT;

ALTER TABLE delivery_permission_lines
  ADD COLUMN IF NOT EXISTS carton_weight NUMERIC(18,3),
  ADD COLUMN IF NOT EXISTS piece_count NUMERIC(18,3),
  ADD COLUMN IF NOT EXISTS sample_quantity NUMERIC(18,3),
  ADD COLUMN IF NOT EXISTS details TEXT;

ALTER TABLE order_price_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_price_change_items ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version)
VALUES ('1013_order_price_changes_and_delivery_details')
ON CONFLICT(version) DO NOTHING;
