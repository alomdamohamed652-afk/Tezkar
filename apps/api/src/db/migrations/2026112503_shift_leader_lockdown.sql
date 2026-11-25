-- مقترح قفل دور رئيس الوردية — بانتظار اعتماد محمد قبل التشغيل.
-- مبني على طلبه (25 نوفمبر 05:13): إخفاء الطلبيات/العهد نقدي وعيني/الحضور والبصمة/
-- البيانات الأساسية/شمول المخزون/طلبات قبض العمال/الأسعار، وإظهار التكويد والعكسي
-- والاستلامات والتسليمات فقط، مع عزل مستحقاته الخاصة.
-- آمن لإعادة التشغيل: كل INSERT بـON CONFLICT DO NOTHING وكل DELETE محدد بالكود.

-- الإضافات (5): عكسي عرض+سكان+طباعة (بدون manage)، استلامات عرض، قبض خاص.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p
  ON p.code IN ('payment_requests.view_own','warehouse.receipt.view',
                'reverse_coding.view','reverse_coding.scan','reverse_coding.print')
WHERE r.code='shift_leader'
ON CONFLICT DO NOTHING;

-- الحذوف (12): الطلبيات/الأسعار/البيانات الأساسية/المخزن الشامل/العهد عامة وخاصة/
-- الحضور العام/توزيعات مالية/قبض عمال عام.
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id
  AND r.code='shift_leader'
  AND p.code IN ('payment_requests.view','rates.view','orders.view','products.view',
                 'shifts.view','employees.lookup','warehouse.view','cash_custody.view',
                 'attendance.view','finance.allocations.view',
                 'custody.view_own','cash_custody.view_own');

-- قرار إنتاج الماكينات معلّق على إجابة محمد:
-- لو قال يخفيها: يُضاف machine_production.view وmachine_production.create وmachines.view للحذوف.
