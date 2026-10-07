CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS coding_packaging_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  default_width_mm numeric(8,2) NOT NULL DEFAULT 80,
  default_height_mm numeric(8,2) NOT NULL DEFAULT 50,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coding_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  packaging_type_id uuid NULL,
  width_mm numeric(8,2) NOT NULL,
  height_mm numeric(8,2) NOT NULL,
  orientation text NOT NULL DEFAULT 'LANDSCAPE' CHECK (orientation IN ('LANDSCAPE','PORTRAIT')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coding_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  barcode text NOT NULL UNIQUE,
  packaging_type_id uuid NOT NULL,
  template_id uuid NULL,
  product_id uuid NOT NULL,
  production_order_id uuid NULL,
  batch_code text NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_id uuid NULL,
  weight numeric(14,3) NULL CHECK (weight IS NULL OR weight >= 0),
  production_owner_employee_id uuid NULL,
  packed_by_employee_id uuid NULL,
  received_by_employee_id uuid NULL,
  packed_at timestamptz NULL,
  coded_at timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NULL,
  location_id uuid NULL,
  status text NOT NULL DEFAULT 'CODED' CHECK (status IN ('CODED','IN_STOCK','RESERVED','READY_FOR_DELIVERY','DELIVERED','OUT','CANCELLED')),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coding_units_product ON coding_units(product_id);
CREATE INDEX IF NOT EXISTS idx_coding_units_status ON coding_units(status);
CREATE INDEX IF NOT EXISTS idx_coding_units_created_at ON coding_units(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coding_units_order ON coding_units(production_order_id);

CREATE TABLE IF NOT EXISTS coding_unit_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coding_unit_id uuid NOT NULL,
  movement_type text NOT NULL,
  from_warehouse_id uuid NULL,
  from_location_id uuid NULL,
  to_warehouse_id uuid NULL,
  to_location_id uuid NULL,
  reference_type text NULL,
  reference_id uuid NULL,
  notes text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coding_movements_unit ON coding_unit_movements(coding_unit_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coding_print_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coding_unit_id uuid NOT NULL,
  print_type text NOT NULL DEFAULT 'INITIAL',
  template_id uuid NULL,
  printed_by uuid NULL,
  printed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coding_print_logs_unit ON coding_print_logs(coding_unit_id, printed_at DESC);

CREATE TABLE IF NOT EXISTS coding_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coding_unit_id uuid NOT NULL,
  field_name text NOT NULL,
  old_value text NULL,
  new_value text NULL,
  reason text NOT NULL,
  corrected_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO coding_packaging_types(code,name,default_width_mm,default_height_mm)
VALUES
 ('BAG','كيس',60,40),
 ('CARTON','كرتونة',80,50),
 ('SACK','شيكارة',100,60),
 ('OTHER','أخرى',80,50)
ON CONFLICT (code) DO NOTHING;

INSERT INTO coding_templates(name,packaging_type_id,width_mm,height_mm,orientation,config,is_default)
SELECT 'قالب الكيس', id, 60, 40, 'LANDSCAPE',
 '{"showLogo":true,"showCompanyName":true,"showProduct":true,"showBatch":true,"showQuantity":true,"showWeight":true,"showCode":true,"showBarcode":true,"showPackedDate":true,"showCodedTime":true,"showAddress":true}'::jsonb,
 false
FROM coding_packaging_types WHERE code='BAG'
AND NOT EXISTS (SELECT 1 FROM coding_templates WHERE name='قالب الكيس');

INSERT INTO coding_templates(name,packaging_type_id,width_mm,height_mm,orientation,config,is_default)
SELECT 'قالب الكرتونة', id, 80, 50, 'LANDSCAPE',
 '{"showLogo":true,"showCompanyName":true,"showProduct":true,"showBatch":true,"showQuantity":true,"showWeight":true,"showCode":true,"showBarcode":true,"showPackedDate":true,"showCodedTime":true,"showAddress":true}'::jsonb,
 true
FROM coding_packaging_types WHERE code='CARTON'
AND NOT EXISTS (SELECT 1 FROM coding_templates WHERE name='قالب الكرتونة');

INSERT INTO coding_templates(name,packaging_type_id,width_mm,height_mm,orientation,config,is_default)
SELECT 'قالب الشيكارة', id, 100, 60, 'LANDSCAPE',
 '{"showLogo":true,"showCompanyName":true,"showProduct":true,"showBatch":true,"showQuantity":true,"showWeight":true,"showCode":true,"showBarcode":true,"showPackedDate":true,"showCodedTime":true,"showAddress":true}'::jsonb,
 false
FROM coding_packaging_types WHERE code='SACK'
AND NOT EXISTS (SELECT 1 FROM coding_templates WHERE name='قالب الشيكارة');

INSERT INTO coding_templates(name,packaging_type_id,width_mm,height_mm,orientation,config,is_default)
SELECT 'قالب عام', id, 80, 50, 'LANDSCAPE',
 '{"showLogo":true,"showCompanyName":true,"showProduct":true,"showBatch":true,"showQuantity":true,"showWeight":true,"showCode":true,"showBarcode":true,"showPackedDate":true,"showCodedTime":true,"showAddress":true}'::jsonb,
 false
FROM coding_packaging_types WHERE code='OTHER'
AND NOT EXISTS (SELECT 1 FROM coding_templates WHERE name='قالب عام');
