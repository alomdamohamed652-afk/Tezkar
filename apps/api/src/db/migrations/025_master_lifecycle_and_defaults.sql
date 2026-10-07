-- Tezkar v0.5: complete master-data lifecycle, safe deactivation and worker own-access fixes

INSERT INTO permissions(code,module,entity,action,scope) VALUES
 ('departments.delete','hr','department','delete','all'),
 ('job_titles.delete','hr','job_title','delete','all'),
 ('products.delete','master','product','delete','all'),
 ('product_categories.delete','master','product_category','delete','all'),
 ('stages.delete','production','stage','delete','all'),
 ('production_types.delete','production','production_type','delete','all'),
 ('rates.delete','production','rate','delete','all'),
 ('rate_groups.delete','production','rate_group','delete','all'),
 ('shifts.delete','production','shift','delete','all'),
 ('warehouses.delete','warehouse','warehouse','delete','all'),
 ('machines.delete','production','machine','delete','all'),
 ('orders.delete','orders','order','delete','all')
ON CONFLICT(code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='worker'
  AND p.code IN ('production.view_own','earnings.view_own','account.change_password')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager'
  AND p.code IN (
    'departments.delete','job_titles.delete','products.delete','product_categories.delete',
    'stages.delete','production_types.delete','rates.delete','rate_groups.delete',
    'shifts.delete','warehouses.delete','machines.delete','orders.delete'
  )
ON CONFLICT DO NOTHING;

-- Stable starter master data. Existing records are never overwritten.
INSERT INTO rate_groups(code,name,description) VALUES
 ('DEFAULT','الأجر الأساسي','مجموعة الأجر الافتراضية'),
 ('PRODUCTION','إنتاج','مجموعة أجر الإنتاج')
ON CONFLICT(code) DO NOTHING;

INSERT INTO departments(code,name) VALUES
 ('PROD','التشغيل والإنتاج'),
 ('WH','المخزن'),
 ('ADMIN','الإدارة'),
 ('HR','الموارد البشرية'),
 ('ACC','الحسابات')
ON CONFLICT(code) DO NOTHING;

INSERT INTO job_titles(code,name,department_id)
SELECT v.code,v.name,d.id
FROM (VALUES
 ('WORKER','عامل إنتاج','PROD'),
 ('SHIFT_LEADER','رئيس وردية','PROD'),
 ('PROD_SUPERVISOR','مشرف إنتاج','PROD'),
 ('WAREHOUSE_KEEPER','مسؤول مخزن','WH'),
 ('WAREHOUSE_MANAGER','مدير مخزن','WH'),
 ('HR_SPECIALIST','مسؤول موارد بشرية','HR'),
 ('ACCOUNTANT','محاسب','ACC'),
 ('MANAGER','مدير','ADMIN')
) AS v(code,name,department_code)
LEFT JOIN departments d ON d.code=v.department_code
ON CONFLICT(code) DO NOTHING;

INSERT INTO shifts(code,name,start_time,end_time,crosses_midnight,rate_group_id)
SELECT 'MORNING','الوردية الصباحية','08:00','16:00',FALSE,id FROM rate_groups WHERE code='PRODUCTION'
ON CONFLICT(code) DO NOTHING;

INSERT INTO shifts(code,name,start_time,end_time,crosses_midnight,rate_group_id)
SELECT 'EVENING','الوردية المسائية','16:00','00:00',TRUE,id FROM rate_groups WHERE code='PRODUCTION'
ON CONFLICT(code) DO NOTHING;

INSERT INTO product_categories(code,name,category_type) VALUES
 ('PRODUCTS','منتجات','PRODUCT'),
 ('RAW_MATERIALS','خامات','RAW_MATERIAL'),
 ('PRODUCTION_SUPPLIES','مستلزمات إنتاج','PRODUCTION_SUPPLY'),
 ('OPERATING_SUPPLIES','مستلزمات تشغيل','OPERATING_SUPPLY')
ON CONFLICT(code) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES ('025_master_lifecycle_and_defaults')
ON CONFLICT(version) DO NOTHING;
