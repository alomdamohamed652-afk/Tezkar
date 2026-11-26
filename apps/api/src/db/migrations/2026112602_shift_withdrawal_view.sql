-- صلاحية «عرض مسحوبات الوردية»: قائمة أذون الصرف وتفاصيلها وطباعتها دون فتح باقي شاشات المخزن.
-- تُمنح لدور shift_leader حصرًا في هذا الترحيل (طلب محمد 26 نوفمبر: رئيس الوردية يشوف نظام مسحوبات الوردية).
-- من يملك warehouse.view (المخزن الكامل) يحتفظ بنفس القدرة لأن فحص السيرفر يقبل أيًا من الصلاحيتين.
-- آمن لإعادة التشغيل.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
('warehouse.shift_withdrawal.view','warehouse','shift_withdrawal','view','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='warehouse.shift_withdrawal.view'
WHERE r.code='shift_leader'
ON CONFLICT DO NOTHING;
