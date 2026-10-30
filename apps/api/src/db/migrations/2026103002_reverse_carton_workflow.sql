ALTER TABLE reverse_code_groups
  ADD COLUMN IF NOT EXISTS display_product_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS weight_min_kg NUMERIC(10,3) NULL CHECK (weight_min_kg IS NULL OR weight_min_kg >= 0),
  ADD COLUMN IF NOT EXISTS weight_max_kg NUMERIC(10,3) NULL CHECK (weight_max_kg IS NULL OR weight_max_kg >= 0);

CREATE TABLE IF NOT EXISTS reverse_code_carton_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL UNIQUE REFERENCES reverse_codes(id) ON DELETE RESTRICT,
  product_id UUID NULL REFERENCES products(id) ON DELETE SET NULL,
  display_product_name TEXT NULL,
  production_partner_employee_id UUID NULL REFERENCES employees(id) ON DELETE SET NULL,
  packer_employee_id UUID NULL REFERENCES employees(id) ON DELETE SET NULL,
  packer_partner_employee_id UUID NULL REFERENCES employees(id) ON DELETE SET NULL,
  coded_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  received_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actual_weight_kg NUMERIC(10,3) NULL CHECK (actual_weight_kg IS NULL OR actual_weight_kg >= 0),
  notes TEXT NULL,
  saved_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reverse_carton_records_product ON reverse_code_carton_records(product_id);
CREATE INDEX IF NOT EXISTS idx_reverse_carton_records_packer ON reverse_code_carton_records(packer_employee_id);
CREATE INDEX IF NOT EXISTS idx_reverse_carton_records_created ON reverse_code_carton_records(created_at DESC);

INSERT INTO permissions(code,module,entity,action,scope)
VALUES ('reverse_coding.rename_product_label','reverse_coding','reverse_code','rename_product_label','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager' AND p.code='reverse_coding.rename_product_label'
ON CONFLICT DO NOTHING;
