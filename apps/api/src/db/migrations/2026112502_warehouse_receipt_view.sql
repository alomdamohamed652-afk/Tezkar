-- C2: صلاحية عرض الاستلامات مستقلة عن warehouse.view العامة.
-- من يرى المخزن كله يستمر عبر warehouse.view؛ warehouse.receipt.view تمنح عرض الاستلامات فقط.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
('warehouse.receipt.view','warehouse','receipt','view','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code='manager' AND p.code='warehouse.receipt.view'
ON CONFLICT DO NOTHING;
