CREATE TABLE IF NOT EXISTS inventory_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  batch_code text NULL,
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  original_quantity numeric(14,3) NOT NULL CHECK (original_quantity > 0),
  remaining_quantity numeric(14,3) NOT NULL CHECK (remaining_quantity >= 0),
  source_type text NOT NULL,
  source_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_product_location
  ON inventory_lots(product_id, warehouse_id, location_id, remaining_quantity);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_batch ON inventory_lots(batch_code);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_created ON inventory_lots(created_at);

CREATE TABLE IF NOT EXISTS stock_movement_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost numeric(16,4) NOT NULL CHECK (total_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(movement_id, lot_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_movement_lots_movement ON stock_movement_lots(movement_id);
CREATE INDEX IF NOT EXISTS idx_stock_movement_lots_lot ON stock_movement_lots(lot_id);

ALTER TABLE stock_movement_lots
  ADD CONSTRAINT stock_movement_lots_movement_fk
  FOREIGN KEY (movement_id) REFERENCES stock_movements(id) ON DELETE CASCADE;
ALTER TABLE stock_movement_lots
  ADD CONSTRAINT stock_movement_lots_lot_fk
  FOREIGN KEY (lot_id) REFERENCES inventory_lots(id);

CREATE SEQUENCE IF NOT EXISTS shift_withdrawal_code_seq START 1;

CREATE TABLE IF NOT EXISTS shift_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT ('WD-' || lpad(nextval('shift_withdrawal_code_seq')::text, 7, '0')),
  shift_id uuid NOT NULL,
  withdrawal_date date NOT NULL DEFAULT CURRENT_DATE,
  employee_id uuid NULL,
  notes text NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shift_withdrawal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL,
  product_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_id uuid NOT NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (withdrawal_id) REFERENCES shift_withdrawals(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (location_id) REFERENCES warehouse_locations(id),
  FOREIGN KEY (unit_id) REFERENCES units(id)
);

CREATE INDEX IF NOT EXISTS idx_shift_withdrawals_date ON shift_withdrawals(withdrawal_date);
CREATE INDEX IF NOT EXISTS idx_shift_withdrawal_lines_product ON shift_withdrawal_lines(product_id);

ALTER TABLE shift_withdrawals
  ADD CONSTRAINT shift_withdrawals_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id),
  ADD CONSTRAINT shift_withdrawals_employee_fk FOREIGN KEY (employee_id) REFERENCES employees(id),
  ADD CONSTRAINT shift_withdrawals_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id);

INSERT INTO schema_migrations(version) VALUES ('1004_inventory_lots_and_shift_withdrawals')
ON CONFLICT(version) DO NOTHING;