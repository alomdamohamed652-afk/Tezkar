-- صلاحية تعديل/حذف إنتاج العمال بسكوب «ما سجّله المستخدم بنفسه» (submitted_by).
-- طلب محمد 25 نوفمبر 15:15: رئيس الوردية يعدّل السجلات التي أدخلها هو فقط،
-- حتى لو مسجّلها لعامل آخر. التقييد من السيرفر وليس مجرد إخفاء في الواجهة.
-- كل حراس الحالة محفوظة: تعديل/حذف المعلّق PENDING فقط، المعتمد عبر
-- production.edit_approved ومسار التصحيح، كلمة المرور للحذف، أقفال الفترات.
-- آمن لإعادة التشغيل.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
('production.edit_own','production','production','edit','own')
ON CONFLICT (code) DO NOTHING;

-- استبدال نطاق تعديل رئيس الوردية: من تعديل أي سجل إلى تعديل ما سجّله بنفسه.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='production.edit_own'
WHERE r.code='shift_leader'
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id
  AND r.code='shift_leader' AND p.code='production.edit';
