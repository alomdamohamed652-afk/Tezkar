-- C1: صلاحية عرض طلبات القبض بسكوب «الخاص» — مستقلة عن كود الدور.
-- العامل يفقد payment_requests.view (العامة) ويأخذ payment_requests.view_own؛
-- أي دور آخر يملك العامة يستمر يرى الكل، وأي دور يُمنح الخاصة يرى طلباته فقط عبر ربط حسابه بموظف.
INSERT INTO permissions(code,module,entity,action,scope) VALUES
('payment_requests.view_own','payroll','payment_request','view','own')
ON CONFLICT (code) DO NOTHING;

-- رئيس الوردية يرث كل صلاحيات العامل (2026101405) — يجب أن يبقى متزامنًا معه.
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.code='payment_requests.view_own'
WHERE r.code IN ('worker','shift_leader')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id=r.id AND rp.permission_id=p.id
  AND r.code IN ('worker','shift_leader') AND p.code='payment_requests.view';
