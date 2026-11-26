-- صلاحية «تعديل مستحق الإنتاج أثناء التسجيل»: إضافة بونص أو خصم ضمن تسجيل إنتاج عامل.
-- البيان إجباري أصلًا في السيرفر (BONUS_REASON_REQUIRED / DEDUCTION_REASON_REQUIRED).
-- تُمنح لدور shift_leader حصرًا في هذا الترحيل؛ من يملك production.adjustments.create
-- يحتفظ بنفس القدرة لأن فحص السيرفر يقبل أيًا من الصلاحيتين.
-- آمن لإعادة التشغيل.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
('production.entry_adjust','production','employee_adjustment','entry_adjust','all')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='production.entry_adjust'
WHERE r.code='shift_leader'
ON CONFLICT DO NOTHING;
