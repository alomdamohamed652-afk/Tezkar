WITH created_scrap_warehouse AS (
  INSERT INTO warehouses(name, warehouse_type)
  SELECT 'مخزن الهالك', 'SCRAP'
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE warehouse_type='SCRAP' AND is_active=TRUE)
  RETURNING id
), scrap_warehouses AS (
  SELECT id FROM created_scrap_warehouse
  UNION
  SELECT id FROM warehouses WHERE warehouse_type='SCRAP' AND is_active=TRUE
)
INSERT INTO warehouse_locations(warehouse_id, code, name)
SELECT sw.id, 'SCRAP-MAIN', 'المكان الرئيسي'
FROM scrap_warehouses sw
WHERE NOT EXISTS (
  SELECT 1 FROM warehouse_locations l
  WHERE l.warehouse_id=sw.id AND l.is_active=TRUE
)
ON CONFLICT (warehouse_id, code) DO UPDATE
SET name=EXCLUDED.name, is_active=TRUE;
