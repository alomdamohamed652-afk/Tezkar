-- إصلاح انحراف نطاق: 2026112502 منح warehouse.receipt.view للمدير خارج الفرق المعتمد
-- (الاعتماد سمّى worker وshift_leader فقط). هذا التصحيح يزيل تلك المنحة فقط.
-- تحقق مسبق: المدير يملك warehouse.view التي تمرّر مسارات الاستلامات عبر
-- requireAnyPermission، فلا فقد وصول فعلي بإزالة المنحة الزائدة.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN roles r ON r.id=rp.role_id
    JOIN permissions p ON p.id=rp.permission_id
    WHERE r.code='manager' AND p.code='warehouse.view'
  ) THEN
    RAISE EXCEPTION 'manager no longer holds warehouse.view; aborting receipt-view repair';
  END IF;
END $$;

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id
  AND r.code='manager' AND p.code='warehouse.receipt.view';
