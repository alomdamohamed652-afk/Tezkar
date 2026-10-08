-- Tezkar v0.9: order-stage pricing and controlled virtual production warehouses

ALTER TABLE order_stages
  ADD COLUMN IF NOT EXISTS stage_rate NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS stage_rate_method TEXT,
  ADD COLUMN IF NOT EXISTS stage_rate_unit_id UUID REFERENCES units(id);

ALTER TABLE order_stages
  DROP CONSTRAINT IF EXISTS order_stages_stage_rate_method_chk;

ALTER TABLE order_stages
  ADD CONSTRAINT order_stages_stage_rate_method_chk
  CHECK (stage_rate_method IS NULL OR stage_rate_method IN ('PER_PIECE','PER_1000','PER_HOUR','PER_DAY','PERCENTAGE'));

CREATE INDEX IF NOT EXISTS idx_order_stages_pricing ON order_stages(stage_rate_method,stage_rate);

-- Exactly three system-controlled operational warehouse types.
INSERT INTO warehouses(name,warehouse_type,is_active)
SELECT 'المخزن الرئيسي للخامات','RAW_MATERIAL',TRUE
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE warehouse_type='RAW_MATERIAL' AND is_active=TRUE);

INSERT INTO warehouses(name,warehouse_type,is_active)
SELECT 'مخزن تحت التشغيل','WIP',TRUE
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE warehouse_type='WIP' AND is_active=TRUE);

INSERT INTO warehouses(name,warehouse_type,is_active)
SELECT 'مخزن المنتجات الجاهزة','FINISHED_GOODS',TRUE
WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE warehouse_type='FINISHED_GOODS' AND is_active=TRUE);

INSERT INTO warehouse_locations(warehouse_id,code,name,is_active)
SELECT w.id,'MAIN','الرئيسي',TRUE
FROM warehouses w
WHERE w.warehouse_type IN ('RAW_MATERIAL','WIP','FINISHED_GOODS')
  AND w.is_active=TRUE
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_locations l WHERE l.warehouse_id=w.id AND l.is_active=TRUE
  );

INSERT INTO schema_migrations(version)
VALUES ('1009_order_stage_pricing_virtual_warehouses')
ON CONFLICT(version) DO NOTHING;
