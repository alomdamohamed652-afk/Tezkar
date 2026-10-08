-- Tezkar v0.8: make warehouse location an internal optional detail
-- Users can work at warehouse level; the system keeps a hidden default location
-- so legacy location-based stock/cost tables remain consistent.

INSERT INTO warehouse_locations(warehouse_id,code,name,is_active)
SELECT w.id,'MAIN','الرئيسي',TRUE
FROM warehouses w
WHERE w.is_active=TRUE
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_locations l WHERE l.warehouse_id=w.id AND l.is_active=TRUE
  );

INSERT INTO schema_migrations(version)
VALUES ('1007_optional_warehouse_locations')
ON CONFLICT(version) DO NOTHING;
